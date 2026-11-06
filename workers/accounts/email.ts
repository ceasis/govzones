/**
 * E-mail one-time-code sign-in. The only identity provider.
 *
 * Privacy: the address is used once, to send the code, and is never written to the identity
 * database. Accounts and pending codes are keyed by HMAC-SHA256(SUBJECT_PEPPER, "email:" + address),
 * so the database cannot be reversed into a mailing list. Addresses are normalised first
 * (lower-case, "+tag" removed, Gmail dots removed) so one mailbox maps to one account.
 */
import { HttpError, nowIso } from "../../shared/http";
import { hmacHex, sha256Hex } from "../../shared/signing";

export interface EmailEnv {
  SUBJECT_PEPPER: string;
  /** Cloudflare Email Sending binding; absent only in local development. */
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  EMAIL_CODE_LIMITER?: RateLimit;
  /** Local development only: return the code in the API response instead of sending mail. */
  DEV_EMAIL_CODES?: string;
}

export const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 4;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value.length < 6 || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return null;
  let [local, domain] = value.split("@") as [string, string];
  local = local.replace(/\+.*$/, "");
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  if (!local) return null;
  return `${local}@${domain}`;
}

export function emailSubject(env: EmailEnv, normalized: string): Promise<string> {
  return hmacHex(env.SUBJECT_PEPPER, `email:${normalized}`);
}

function newCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return String(n).padStart(6, "0");
}

async function send(env: EmailEnv, to: string, code: string): Promise<void> {
  if (!env.EMAIL) throw new HttpError("EMAIL_DELIVERY_FAILED", "E-mail sending is not configured.");
  const from = env.EMAIL_FROM ?? "";
  const pretty = `${code.slice(0, 3)} ${code.slice(3)}`;
  const text = [
    `Your GovZones sign-in code is ${pretty}`,
    "",
    `It expires in ${CODE_TTL_MINUTES} minutes. Enter it on the page where you asked for it.`,
    "",
    "If you did not request this code, you can ignore this message; nobody can sign in without it.",
    "",
    "GovZones is an independent website and is not a government service.",
  ].join("\n");
  const html = `<p style="font:16px/1.5 system-ui,sans-serif;color:#111">Your GovZones sign-in code is</p>
<p style="font:700 32px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;color:#111;margin:8px 0 16px">${pretty}</p>
<p style="font:14px/1.5 system-ui,sans-serif;color:#444">It expires in ${CODE_TTL_MINUTES} minutes. Enter it on the page where you asked for it.<br>
If you did not request this code, ignore this message; nobody can sign in without it.</p>
<p style="font:12px/1.5 system-ui,sans-serif;color:#777">GovZones is an independent website and is not a government service.</p>`;
  try {
    await env.EMAIL.send({ to, from: { email: from, name: "GovZones" }, subject: `${pretty} is your GovZones sign-in code`, text, html });
  } catch (err) {
    // Log only the provider's error code: never the address.
    console.error("email_send_failed", (err as { code?: string }).code ?? "unknown");
    throw new HttpError("EMAIL_DELIVERY_FAILED");
  }
}

async function limitByIp(env: EmailEnv, request: Request) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!env.EMAIL_CODE_LIMITER || !ip) return;
  const { success } = await env.EMAIL_CODE_LIMITER.limit({ key: ip });
  if (!success) throw new HttpError("RATE_LIMITED");
}

/** Issues a code. Returns the code itself only when DEV_EMAIL_CODES=1 (local development). */
export async function startEmailSignIn(env: EmailEnv, db: D1Database, request: Request, rawEmail: unknown): Promise<{ devCode?: string }> {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new HttpError("INVALID_EMAIL");
  await limitByIp(env, request);
  const subject = await emailSubject(env, email);
  const now = Date.now();
  const recent = await db
    .prepare(`SELECT COUNT(*) AS n FROM email_sign_in_codes WHERE email_protected = ?1 AND created_at > ?2`)
    .bind(subject, nowIso(now - 3_600_000))
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR) throw new HttpError("RATE_LIMITED", "Too many codes were requested for this address. Please wait an hour.");

  const id = crypto.randomUUID();
  const code = newCode();
  // Only the newest code for an address is valid.
  await db.batch([
    db.prepare(`UPDATE email_sign_in_codes SET consumed_at = ?2 WHERE email_protected = ?1 AND consumed_at IS NULL`).bind(subject, nowIso(now)),
    db
      .prepare(`INSERT INTO email_sign_in_codes (id, email_protected, code_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(id, subject, await sha256Hex(`${id}:${code}`), nowIso(now), nowIso(now + CODE_TTL_MINUTES * 60_000)),
  ]);
  if (env.DEV_EMAIL_CODES === "1") {
    console.log(`dev sign-in code for ${email}: ${code}`);
    return { devCode: code };
  }
  await send(env, email, code);
  return {};
}

/** Checks a code; on success returns the protected subject for the account. */
export async function verifyEmailSignIn(env: EmailEnv, db: D1Database, rawEmail: unknown, rawCode: unknown): Promise<string> {
  const email = normalizeEmail(rawEmail);
  const code = typeof rawCode === "string" ? rawCode.replace(/\D/g, "") : "";
  if (!email) throw new HttpError("INVALID_EMAIL");
  if (code.length !== 6) throw new HttpError("INVALID_CODE");
  const subject = await emailSubject(env, email);
  const now = nowIso();
  const row = await db
    .prepare(
      `SELECT id, code_hash, attempts, expires_at FROM email_sign_in_codes
        WHERE email_protected = ?1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(subject)
    .first<{ id: string; code_hash: string; attempts: number; expires_at: string }>();
  if (!row || row.expires_at <= now || row.attempts >= MAX_ATTEMPTS) throw new HttpError("CODE_EXPIRED");
  if ((await sha256Hex(`${row.id}:${code}`)) !== row.code_hash) {
    await db.prepare(`UPDATE email_sign_in_codes SET attempts = attempts + 1 WHERE id = ?1`).bind(row.id).run();
    throw new HttpError("INVALID_CODE", row.attempts + 1 >= MAX_ATTEMPTS ? "Too many wrong codes. Request a new one." : undefined);
  }
  const consumed = await db
    .prepare(`UPDATE email_sign_in_codes SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL`)
    .bind(row.id, now)
    .run();
  if (!consumed.meta.changes) throw new HttpError("CODE_EXPIRED");
  return subject;
}

/** Housekeeping for the cron: codes are useless after expiry. */
export async function purgeExpiredCodes(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM email_sign_in_codes WHERE expires_at < ?1`).bind(nowIso(Date.now() - 86_400_000)).run();
}
