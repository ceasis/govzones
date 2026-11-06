/**
 * GovZones Account / Eligibility Worker — served exclusively at accounts.govzones.com.
 *
 * Sign-in establishes eligibility to hold ONE voting credential per account per country.
 * This worker never receives ballots, scores, nullifiers or the entities a user rates,
 * and has no binding to the votes database.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { GroupMembership } from "../groups/index";
import { HttpError, corsHeaders, dayOf, errorResponse, json, nowIso, parseOrigins, readJson } from "../../shared/http";
import { isCountryCode, isFieldElementString, isUuid } from "../../shared/protocol";
import { randomToken, sha256Hex } from "../../shared/signing";
import { isEntityType } from "../../shared/directory";
import { purgeExpiredCodes, startEmailSignIn, verifyEmailSignIn, type EmailEnv } from "./email";

export interface Env extends EmailEnv {
  ACCOUNTS_ORIGIN: string;
  IDENTITY_DB: D1Database;
  /** Write-only use: moderated directory suggestions/corrections (no submitter identity stored). */
  DIRECTORY: D1Database;
  WALLET_BACKUPS: R2Bucket;
  GROUPS: Service<GroupMembership>;
  PUBLIC_ORIGINS: string;
  SUBJECT_PEPPER: string;
  COOKIE_SECURE?: string;
  ACTIVE_COUNTRIES?: string;
  TURNSTILE_SECRET?: string;
  DEV_INSTANT_EPOCH?: string;
  COUNTABLE_MATURITY_HOURS?: string;
  RESET_HOLD_DAYS?: string;
  REENROLL_HOLD_DAYS?: string;
  ENROLL_BURST_PER_HOUR?: string;
}

const SESSION_DAYS = 7;
const CORS_OPTS = { credentials: true, methods: "GET, POST, PUT, DELETE, OPTIONS", headers: "Content-Type, X-CSRF-Token" };

function secure(env: Env) {
  return env.COOKIE_SECURE !== "0";
}
function sessionCookieName(env: Env) {
  return secure(env) ? "__Host-gz_session" : "gz_session";
}
function cookie(env: Env, name: string, value: string, maxAge: number) {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure(env) ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function activeCountries(env: Env): string[] {
  return String(env.ACTIVE_COUNTRIES ?? "PH").split(",").map((c) => c.trim()).filter(isCountryCode);
}

/** Only redirect back to GovZones public origins. */
function safeReturnTo(env: Env, value: string | null): string {
  const origins = parseOrigins(env.PUBLIC_ORIGINS);
  const fallback = `${origins[0] ?? ""}/ph`;
  if (!value) return fallback;
  try {
    const u = new URL(value);
    if (!origins.includes(u.origin)) return fallback;
    return u.toString();
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

interface Session {
  accountId: string;
  csrfHash: string;
  sessionHash: string;
}

async function getSession(request: Request, env: Env): Promise<Session | null> {
  const token = readCookie(request, sessionCookieName(env));
  if (!token || token.length > 128) return null;
  const sessionHash = await sha256Hex(token);
  const row = await env.IDENTITY_DB.prepare(
    `SELECT s.account_id, s.csrf_hash FROM sessions s JOIN accounts a ON a.account_id = s.account_id
      WHERE s.session_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2 AND a.status = 'ACTIVE'`,
  )
    .bind(sessionHash, nowIso())
    .first<{ account_id: string; csrf_hash: string }>();
  return row ? { accountId: row.account_id, csrfHash: row.csrf_hash, sessionHash } : null;
}

async function requireSession(request: Request, env: Env, mutating: boolean): Promise<Session> {
  const session = await getSession(request, env);
  if (!session) throw new HttpError("UNAUTHENTICATED", "Please sign in.");
  if (mutating) {
    const origin = request.headers.get("Origin");
    const allowed = [...parseOrigins(env.PUBLIC_ORIGINS), env.ACCOUNTS_ORIGIN];
    if (!origin || !allowed.includes(origin)) throw new HttpError("CSRF_FAILED");
    const token = request.headers.get("X-CSRF-Token") ?? "";
    if (!token || (await sha256Hex(token)) !== session.csrfHash) throw new HttpError("CSRF_FAILED");
  }
  return session;
}

async function createSession(env: Env, accountId: string): Promise<{ token: string }> {
  const token = randomToken(32);
  const csrf = randomToken(24);
  await env.IDENTITY_DB.prepare(
    `INSERT INTO sessions (session_hash, account_id, csrf_hash, expires_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(await sha256Hex(token), accountId, await sha256Hex(csrf), nowIso(Date.now() + SESSION_DAYS * 86_400_000))
    .run();
  return { token };
}

/** `subject` is the keyed hash of the normalised e-mail address (see email.ts); the address itself is never stored. */
async function upsertAccount(env: Env, subject: string): Promise<string> {
  const existing = await env.IDENTITY_DB.prepare(`SELECT account_id, status FROM accounts WHERE provider_subject_protected = ?1`)
    .bind(subject)
    .first<{ account_id: string; status: string }>();
  if (existing) {
    if (existing.status !== "ACTIVE") throw new HttpError("FORBIDDEN", "This account is suspended.");
    return existing.account_id;
  }
  const accountId = crypto.randomUUID();
  await env.IDENTITY_DB.prepare(
    `INSERT INTO accounts (account_id, provider, provider_subject_protected, created_day) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(accountId, "email", subject, dayOf())
    .run();
  return accountId;
}

/**
 * `formRedirectOrigins`: CSP form-action also governs redirects after a form POST, so a form that
 * signs in and then 303-redirects to the public site must list that origin.
 */
function htmlPage(title: string, body: string, status = 200, headers: Record<string, string> = {}, formRedirectOrigins: string[] = []) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · GovZones accounts</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:0 auto;padding:1.5rem;color:#0f172a}
a,button{font:inherit}button,input{min-height:44px}input{width:100%;padding:.5rem;border:1px solid #64748b;border-radius:.5rem;box-sizing:border-box}
button{padding:.5rem 1rem;border-radius:.5rem;border:1px solid #0f172a;background:#0f172a;color:#fff;cursor:pointer}
.note{background:#fef3c7;border:1px solid #b45309;padding:.75rem;border-radius:.5rem}</style></head>
<body><p><strong>GovZones</strong> · accounts</p>${body}</body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formRedirectOrigins.map((o) => " " + o).join("")}; frame-ancestors 'none'; base-uri 'none'`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        ...headers,
      },
    },
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/* ------------------------------------------------------------------ */
/* E-mail code sign-in                                                 */
/* ------------------------------------------------------------------ */

/** Unauthenticated POSTs are accepted only from GovZones pages (browsers always send Origin on cross-origin fetch). */
function requireTrustedOrigin(request: Request, env: Env): void {
  const origin = request.headers.get("Origin");
  if (!origin || ![...parseOrigins(env.PUBLIC_ORIGINS), env.ACCOUNTS_ORIGIN].includes(origin)) throw new HttpError("CSRF_FAILED");
}

async function emailStart(request: Request, env: Env): Promise<Response> {
  requireTrustedOrigin(request, env);
  const body = await readJson<{ email?: unknown }>(request, 2_048);
  const result = await startEmailSignIn(env, env.IDENTITY_DB, request, body.email);
  return json({ ok: true, ...result });
}

/** A correct code signs the browser in: the session cookie is set on this (credentialed, same-site) response. */
async function emailVerify(request: Request, env: Env): Promise<Response> {
  requireTrustedOrigin(request, env);
  const body = await readJson<{ email?: unknown; code?: unknown }>(request, 2_048);
  const subject = await verifyEmailSignIn(env, env.IDENTITY_DB, body.email, body.code);
  const accountId = await upsertAccount(env, subject);
  const { token } = await createSession(env, accountId);
  return json({ ok: true }, { headers: { "Set-Cookie": cookie(env, sessionCookieName(env), token, SESSION_DAYS * 86_400) } });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, true);
  await env.IDENTITY_DB.prepare(`UPDATE sessions SET revoked_at = ?1 WHERE session_hash = ?2`)
    .bind(nowIso(), session.sessionHash)
    .run();
  return json({ ok: true }, { headers: { "Set-Cookie": cookie(env, sessionCookieName(env), "", 0) } });
}

/* ------------------------------------------------------------------ */
/* Session & wallet enrollment                                         */
/* ------------------------------------------------------------------ */

async function sessionInfo(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return json({ signedIn: false });
  // Rotate the CSRF token on every session read; only allowed origins can read it (CORS).
  const csrf = randomToken(24);
  await env.IDENTITY_DB.prepare(`UPDATE sessions SET csrf_hash = ?1 WHERE session_hash = ?2`)
    .bind(await sha256Hex(csrf), session.sessionHash)
    .run();
  const enrollments = await env.IDENTITY_DB.prepare(
    `SELECT country_code, public_commitment, trust_group_state FROM identity_enrollments
      WHERE account_id = ?1 AND revoked_at IS NULL`,
  )
    .bind(session.accountId)
    .all<{ country_code: string; public_commitment: string; trust_group_state: string }>();
  const backup = await env.IDENTITY_DB.prepare(
    `SELECT backup_version, updated_day FROM encrypted_wallet_backups WHERE account_id = ?1`,
  )
    .bind(session.accountId)
    .first<{ backup_version: number; updated_day: string }>();
  const resets = await env.IDENTITY_DB.prepare(
    `SELECT country_code, status FROM wallet_reset_requests WHERE account_id = ?1 ORDER BY created_day DESC LIMIT 5`,
  )
    .bind(session.accountId)
    .all<{ country_code: string; status: string }>();
  return json({
    signedIn: true,
    csrfToken: csrf,
    // The public commitment is returned so the wallet can confirm it matches; trust tier is not exposed.
    enrollments: enrollments.results.map((e) => ({ country: e.country_code, commitment: e.public_commitment })),
    backup: backup ? { version: backup.backup_version, updatedDay: backup.updated_day } : null,
    resetRequests: resets.results.map((r) => ({ country: r.country_code, status: r.status })),
  });
}

async function verifyTurnstile(env: Env, token: unknown): Promise<void> {
  if (!env.TURNSTILE_SECRET) return; // not configured (local development)
  if (typeof token !== "string" || token.length > 2048) throw new HttpError("TURNSTILE_FAILED");
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token }),
  });
  const data = (await res.json()) as { success?: boolean };
  if (!data.success) throw new HttpError("TURNSTILE_FAILED");
}

async function activeRisk(env: Env, accountId: string, actions: string[]): Promise<boolean> {
  const row = await env.IDENTITY_DB.prepare(
    `SELECT 1 FROM enrollment_risk_actions WHERE account_id = ?1 AND action IN (${actions.map(() => "?").join(",")})
       AND (expires_at IS NULL OR expires_at > ?${actions.length + 2}) LIMIT 1`,
  )
    .bind(accountId, ...actions, nowIso())
    .first();
  return Boolean(row);
}

async function enroll(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const session = await requireSession(request, env, true);
  const body = await readJson<{ country?: unknown; commitment?: unknown; turnstileToken?: unknown }>(request, 4096);
  const country = body.country;
  if (!isCountryCode(country) || !activeCountries(env).includes(country)) throw new HttpError("BAD_REQUEST", "Unsupported country.");
  if (!isFieldElementString(body.commitment) || body.commitment === "0") throw new HttpError("BAD_REQUEST", "Invalid commitment.");
  const commitment = body.commitment;
  await verifyTurnstile(env, body.turnstileToken);
  if (await activeRisk(env, session.accountId, ["BLOCK_ENROLLMENT"])) throw new HttpError("ENROLLMENT_BLOCKED");

  const db = env.IDENTITY_DB;
  const current = await db
    .prepare(`SELECT public_commitment FROM identity_enrollments WHERE account_id = ?1 AND country_code = ?2 AND revoked_at IS NULL`)
    .bind(session.accountId, country)
    .first<{ public_commitment: string }>();
  if (current) {
    if (current.public_commitment === commitment) return json({ status: "enrolled" });
    // Never silently enroll a second identity for the same account (duplicate-voting path).
    throw new HttpError(
      "ALREADY_ENROLLED",
      "This account already has a voting pass. Restore it with your recovery key, or request a reset.",
    );
  }

  const now = Date.now();
  const holds: number[] = [now + Number(env.COUNTABLE_MATURITY_HOURS ?? 72) * 3_600_000];
  const account = await db
    .prepare(`SELECT provider_subject_protected FROM accounts WHERE account_id = ?1`)
    .bind(session.accountId)
    .first<{ provider_subject_protected: string }>();
  const tomb = await db
    .prepare(`SELECT hold_until FROM deleted_account_tombstones WHERE provider_subject_protected = ?1`)
    .bind(account!.provider_subject_protected)
    .first<{ hold_until: string }>();
  if (tomb) holds.push(Date.parse(tomb.hold_until));
  const reset = await db
    .prepare(`SELECT 1 FROM wallet_reset_requests WHERE account_id = ?1 AND country_code = ?2 AND status = 'APPROVED' LIMIT 1`)
    .bind(session.accountId, country)
    .first();
  if (reset) holds.push(now + Number(env.RESET_HOLD_DAYS ?? 365) * 86_400_000);

  // Coarse hourly velocity bucket for burst detection (no per-account timestamp).
  const bucket = `${country}:${nowIso(now).slice(0, 13)}`;
  const vel = await db
    .prepare(`INSERT INTO enrollment_velocity (bucket, count) VALUES (?1, 1) ON CONFLICT (bucket) DO UPDATE SET count = count + 1 RETURNING count`)
    .bind(bucket)
    .first<{ count: number }>();
  if ((vel?.count ?? 0) > Number(env.ENROLL_BURST_PER_HOUR ?? 500)) {
    await db
      .prepare(
        `INSERT INTO enrollment_risk_actions (id, account_id, risk_reason_code, action, case_ref, created_at, expires_at)
         VALUES (?1, ?2, 'ENROLLMENT_BURST', 'HOLD_SUBMIT_ONLY', ?3, ?4, ?5)`,
      )
      .bind(crypto.randomUUID(), session.accountId, `EA-${randomToken(4)}`, nowIso(now), nowIso(now + 30 * 86_400_000))
      .run();
  }

  try {
    await db
      .prepare(
        `INSERT INTO identity_enrollments (id, account_id, country_code, public_commitment, enrolled_day, eligible_for_countable_after)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(crypto.randomUUID(), session.accountId, country, commitment, dayOf(now), nowIso(Math.max(...holds)))
      .run();
  } catch {
    throw new HttpError("CONFLICT", "This voting pass cannot be registered. Please try again.");
  }
  const result = await env.GROUPS.addMember(country, commitment, "submit");
  if (env.DEV_INSTANT_EPOCH === "1") ctx.waitUntil(env.GROUPS.publishNow().then(() => undefined));
  return json({ status: "enrolled", membership: result.status });
}

/* ------------------------------------------------------------------ */
/* Encrypted wallet backup (ciphertext only)                           */
/* ------------------------------------------------------------------ */

const MAX_BACKUP_CHARS = 64 * 1024;

async function getBackup(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, false);
  const row = await env.IDENTITY_DB.prepare(
    `SELECT ciphertext_object_key, backup_version, updated_day FROM encrypted_wallet_backups WHERE account_id = ?1`,
  )
    .bind(session.accountId)
    .first<{ ciphertext_object_key: string; backup_version: number; updated_day: string }>();
  if (!row) throw new HttpError("NOT_FOUND");
  const obj = await env.WALLET_BACKUPS.get(row.ciphertext_object_key);
  if (!obj) throw new HttpError("NOT_FOUND");
  return json({ ciphertext: await obj.text(), version: row.backup_version, updatedDay: row.updated_day });
}

async function putBackup(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, true);
  const body = await readJson<{ ciphertext?: unknown; version?: unknown }>(request, MAX_BACKUP_CHARS + 1024);
  if (typeof body.ciphertext !== "string" || body.ciphertext.length > MAX_BACKUP_CHARS || !/^[A-Za-z0-9_.\-]+$/.test(body.ciphertext)) {
    throw new HttpError("BAD_REQUEST", "Backup must be an opaque encrypted envelope.");
  }
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 1) throw new HttpError("BAD_REQUEST");
  const key = `wallet/${crypto.randomUUID()}`;
  await env.WALLET_BACKUPS.put(key, body.ciphertext, { httpMetadata: { contentType: "text/plain" } });
  const prev = await env.IDENTITY_DB.prepare(`SELECT ciphertext_object_key FROM encrypted_wallet_backups WHERE account_id = ?1`)
    .bind(session.accountId)
    .first<{ ciphertext_object_key: string }>();
  await env.IDENTITY_DB.prepare(
    `INSERT INTO encrypted_wallet_backups (account_id, ciphertext_object_key, backup_version, updated_day)
       VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (account_id) DO UPDATE SET ciphertext_object_key = excluded.ciphertext_object_key,
       backup_version = excluded.backup_version, updated_day = excluded.updated_day`,
  )
    .bind(session.accountId, key, version, dayOf())
    .run();
  if (prev) await env.WALLET_BACKUPS.delete(prev.ciphertext_object_key);
  return json({ ok: true, version });
}

async function deleteBackup(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, true);
  const prev = await env.IDENTITY_DB.prepare(`SELECT ciphertext_object_key FROM encrypted_wallet_backups WHERE account_id = ?1`)
    .bind(session.accountId)
    .first<{ ciphertext_object_key: string }>();
  if (prev) {
    await env.WALLET_BACKUPS.delete(prev.ciphertext_object_key);
    await env.IDENTITY_DB.prepare(`DELETE FROM encrypted_wallet_backups WHERE account_id = ?1`).bind(session.accountId).run();
  }
  return json({ ok: true });
}

async function resetRequest(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, true);
  const body = await readJson<{ country?: unknown }>(request, 512);
  if (!isCountryCode(body.country)) throw new HttpError("BAD_REQUEST");
  await env.IDENTITY_DB.prepare(
    `INSERT INTO wallet_reset_requests (id, account_id, country_code, created_day) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT DO NOTHING`,
  )
    .bind(crypto.randomUUID(), session.accountId, body.country, dayOf())
    .run();
  return json({ status: "pending_review" });
}

/** Revokes membership, sessions, enrollments and ciphertext. Cannot (by design) locate old anonymous ballots. */
async function deleteAccount(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, true);
  const body = await readJson<{ confirm?: unknown }>(request, 512);
  if (body.confirm !== "DELETE MY ACCOUNT") throw new HttpError("BAD_REQUEST", "Confirmation phrase required.");
  const db = env.IDENTITY_DB;
  const enrollments = await db
    .prepare(`SELECT country_code, public_commitment FROM identity_enrollments WHERE account_id = ?1`)
    .bind(session.accountId)
    .all<{ country_code: string; public_commitment: string }>();
  for (const e of enrollments.results) await env.GROUPS.revokeMember(e.country_code, e.public_commitment);
  const backup = await db
    .prepare(`SELECT ciphertext_object_key FROM encrypted_wallet_backups WHERE account_id = ?1`)
    .bind(session.accountId)
    .first<{ ciphertext_object_key: string }>();
  if (backup) await env.WALLET_BACKUPS.delete(backup.ciphertext_object_key);
  const account = await db
    .prepare(`SELECT provider_subject_protected FROM accounts WHERE account_id = ?1`)
    .bind(session.accountId)
    .first<{ provider_subject_protected: string }>();
  const holdUntil = nowIso(Date.now() + Number(env.REENROLL_HOLD_DAYS ?? 365) * 86_400_000);
  await db.batch([
    db
      .prepare(
        `INSERT INTO deleted_account_tombstones (provider_subject_protected, hold_until) VALUES (?1, ?2)
           ON CONFLICT (provider_subject_protected) DO UPDATE SET hold_until = excluded.hold_until`,
      )
      .bind(account!.provider_subject_protected, holdUntil),
    db.prepare(`DELETE FROM sessions WHERE account_id = ?1`).bind(session.accountId),
    db.prepare(`DELETE FROM identity_enrollments WHERE account_id = ?1`).bind(session.accountId),
    db.prepare(`DELETE FROM encrypted_wallet_backups WHERE account_id = ?1`).bind(session.accountId),
    db.prepare(`DELETE FROM enrollment_risk_actions WHERE account_id = ?1`).bind(session.accountId),
    db.prepare(`DELETE FROM wallet_reset_requests WHERE account_id = ?1`).bind(session.accountId),
    db.prepare(`DELETE FROM account_quota WHERE account_id = ?1`).bind(session.accountId),
    db.prepare(`DELETE FROM accounts WHERE account_id = ?1`).bind(session.accountId),
    db
      .prepare(`INSERT INTO identity_audit (id, action, actor_role, actor_ref, created_at, summary) VALUES (?1, 'ACCOUNT_DELETED', 'self', 'self', ?2, '{}')`)
      .bind(crypto.randomUUID(), dayOf()),
  ]);
  return json({ ok: true }, { headers: { "Set-Cookie": cookie(env, sessionCookieName(env), "", 0) } });
}

/* ------------------------------------------------------------------ */
/* Directory suggestions & corrections (moderated)                     */
/* ------------------------------------------------------------------ */

async function takeQuota(env: Env, accountId: string, kind: string, limit: number) {
  const row = await env.IDENTITY_DB.prepare(
    `INSERT INTO account_quota (account_id, bucket, count) VALUES (?1, ?2, 1)
       ON CONFLICT (account_id, bucket) DO UPDATE SET count = count + 1 RETURNING count`,
  )
    .bind(accountId, `${kind}:${dayOf()}`)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > limit) throw new HttpError("RATE_LIMITED");
}

function cleanText(value: unknown, max: number, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError("BAD_REQUEST", "Missing required field.");
    return null;
  }
  if (typeof value !== "string") throw new HttpError("BAD_REQUEST");
  const v = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (required && !v) throw new HttpError("BAD_REQUEST", "Missing required field.");
  return v.slice(0, max);
}

function cleanUrl(value: unknown, required: boolean): string | null {
  const v = cleanText(value, 500, required);
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    return u.toString();
  } catch {
    throw new HttpError("BAD_REQUEST", "Please provide a valid source link (https://…).");
  }
}

async function suggest(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, true);
  const body = await readJson<Record<string, unknown>>(request, 4096);
  const country = body.country;
  if (!isCountryCode(country) || !activeCountries(env).includes(country)) throw new HttpError("BAD_REQUEST");
  if (!isEntityType(body.type)) throw new HttpError("BAD_REQUEST", "Choose the kind of office.");
  const parent = body.parentEntityId ? (isUuid(body.parentEntityId) ? body.parentEntityId : null) : null;
  const geo = typeof body.geoUnitId === "string" && /^[a-z0-9-]{1,64}$/.test(body.geoUnitId) ? body.geoUnitId : null;
  await takeQuota(env, session.accountId, "suggest", 10);
  const id = crypto.randomUUID();
  await env.DIRECTORY.prepare(
    `INSERT INTO entity_suggestions
       (id, country_code, suggested_name, suggested_type, parent_entity_id, geo_unit_id, address, source_url, notes, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      id,
      country,
      cleanText(body.name, 200, true),
      body.type,
      parent,
      geo,
      cleanText(body.address, 300),
      cleanUrl(body.sourceUrl, true),
      cleanText(body.notes, 1000),
      nowIso(),
      nowIso(Date.now() + 180 * 86_400_000),
    )
    .run();
  return json({ status: "received", reference: id.slice(0, 8).toUpperCase() });
}

async function correction(request: Request, env: Env, entityId: string): Promise<Response> {
  const session = await requireSession(request, env, true);
  const body = await readJson<Record<string, unknown>>(request, 4096);
  const entity = await env.DIRECTORY.prepare(`SELECT id FROM entities WHERE id = ?1`).bind(entityId).first();
  if (!entity) throw new HttpError("NOT_FOUND");
  const field = cleanText(body.field, 40, true)!;
  if (!["name", "address", "website", "parent", "location", "status", "duplicate", "other"].includes(field)) {
    throw new HttpError("BAD_REQUEST");
  }
  await takeQuota(env, session.accountId, "correct", 20);
  await env.DIRECTORY.prepare(
    `INSERT INTO entity_corrections (id, entity_id, field, details, source_url, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(crypto.randomUUID(), entityId, field, cleanText(body.details, 1000, true), cleanUrl(body.sourceUrl, false), nowIso(), nowIso(Date.now() + 180 * 86_400_000))
    .run();
  return json({ status: "received" });
}

/* ------------------------------------------------------------------ */
/* Stage-1 trust promotion (before any ballot exists)                  */
/* ------------------------------------------------------------------ */

/**
 * Promotes matured, unflagged enrollments into the Countable Group and demotes flagged ones.
 * Uses only account-enrollment signals: never agency IDs, scores or nullifiers.
 */
export async function runTrustScreening(env: Env, now = Date.now()) {
  const db = env.IDENTITY_DB;
  const ts = nowIso(now);
  const promotable = await db
    .prepare(
      `SELECT e.id, e.country_code, e.public_commitment FROM identity_enrollments e
         JOIN accounts a ON a.account_id = e.account_id
        WHERE e.revoked_at IS NULL AND e.trust_group_state = 'SUBMIT' AND e.eligible_for_countable_after <= ?1
          AND a.status = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM enrollment_risk_actions r WHERE r.account_id = e.account_id
                            AND r.action IN ('HOLD_SUBMIT_ONLY', 'BLOCK_ENROLLMENT')
                            AND (r.expires_at IS NULL OR r.expires_at > ?1))
        LIMIT 500`,
    )
    .bind(ts)
    .all<{ id: string; country_code: string; public_commitment: string }>();
  let promoted = 0;
  for (const e of promotable.results) {
    const res = await env.GROUPS.addMember(e.country_code, e.public_commitment, "countable");
    if (res.status !== "revoked") {
      await db.prepare(`UPDATE identity_enrollments SET trust_group_state = 'COUNTABLE' WHERE id = ?1`).bind(e.id).run();
      promoted++;
    }
  }
  const flagged = await db
    .prepare(
      `SELECT e.id, e.country_code, e.public_commitment FROM identity_enrollments e
        WHERE e.revoked_at IS NULL AND e.trust_group_state = 'COUNTABLE'
          AND EXISTS (SELECT 1 FROM enrollment_risk_actions r WHERE r.account_id = e.account_id
                        AND r.action IN ('HOLD_SUBMIT_ONLY', 'BLOCK_ENROLLMENT')
                        AND (r.expires_at IS NULL OR r.expires_at > ?1))
        LIMIT 500`,
    )
    .bind(ts)
    .all<{ id: string; country_code: string; public_commitment: string }>();
  for (const e of flagged.results) {
    // Removes FUTURE countable proofs only; past ballots cannot (and must not) be located by account.
    await env.GROUPS.revokeMember(e.country_code, e.public_commitment, "countable");
    await db.prepare(`UPDATE identity_enrollments SET trust_group_state = 'SUBMIT' WHERE id = ?1`).bind(e.id).run();
  }
  await db.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(ts).run();
  await db
    .prepare(`DELETE FROM enrollment_velocity WHERE substr(bucket, instr(bucket, ':') + 1) < ?1`)
    .bind(nowIso(now - 2 * 86_400_000).slice(0, 13))
    .run();
  return { promoted, demoted: flagged.results.length };
}

/** Admin RPC: enrollment-side trust operations only. */
export class AccountsAdmin extends WorkerEntrypoint<Env> {
  async stats() {
    const db = this.env.IDENTITY_DB;
    const accounts = await db.prepare(`SELECT COUNT(*) AS n FROM accounts`).first<{ n: number }>();
    const states = await db
      .prepare(`SELECT country_code, trust_group_state, COUNT(*) AS n FROM identity_enrollments WHERE revoked_at IS NULL GROUP BY 1, 2`)
      .all();
    const risk = await db
      .prepare(`SELECT risk_reason_code, action, COUNT(*) AS n FROM enrollment_risk_actions WHERE expires_at IS NULL OR expires_at > ?1 GROUP BY 1, 2`)
      .bind(nowIso())
      .all();
    return { accounts: accounts?.n ?? 0, enrollments: states.results, activeRiskActions: risk.results };
  }

  async listResetRequests() {
    const { results } = await this.env.IDENTITY_DB.prepare(
      `SELECT id, country_code, status, created_day, case_ref FROM wallet_reset_requests ORDER BY created_day DESC LIMIT 100`,
    ).all();
    return results;
  }

  /** Approving a reset revokes the old commitment; the new one stays submit-only for RESET_HOLD_DAYS. */
  async resolveResetRequest(id: string, approve: boolean, actor: { role: string; ref: string }) {
    const db = this.env.IDENTITY_DB;
    const req = await db
      .prepare(`SELECT account_id, country_code, status FROM wallet_reset_requests WHERE id = ?1`)
      .bind(id)
      .first<{ account_id: string; country_code: string; status: string }>();
    if (!req || req.status !== "PENDING") return { ok: false };
    const caseRef = `WR-${randomToken(4)}`;
    if (approve) {
      const e = await db
        .prepare(`SELECT id, public_commitment FROM identity_enrollments WHERE account_id = ?1 AND country_code = ?2 AND revoked_at IS NULL`)
        .bind(req.account_id, req.country_code)
        .first<{ id: string; public_commitment: string }>();
      if (e) {
        await this.env.GROUPS.revokeMember(req.country_code, e.public_commitment);
        await db
          .prepare(`UPDATE identity_enrollments SET revoked_at = ?1, trust_group_state = 'REVOKED' WHERE id = ?2`)
          .bind(nowIso(), e.id)
          .run();
      }
    }
    await db.batch([
      db
        .prepare(`UPDATE wallet_reset_requests SET status = ?1, reviewed_at = ?2, case_ref = ?3 WHERE id = ?4`)
        .bind(approve ? "APPROVED" : "REJECTED", nowIso(), caseRef, id),
      db
        .prepare(`INSERT INTO identity_audit (id, action, actor_role, actor_ref, case_ref, created_at, summary) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}')`)
        .bind(crypto.randomUUID(), approve ? "WALLET_RESET_APPROVED" : "WALLET_RESET_REJECTED", actor.role, actor.ref, caseRef, nowIso()),
    ]);
    return { ok: true, caseRef };
  }

  async listRiskActions() {
    const { results } = await this.env.IDENTITY_DB.prepare(
      `SELECT id, risk_reason_code, action, case_ref, created_at, expires_at FROM enrollment_risk_actions ORDER BY created_at DESC LIMIT 100`,
    ).all();
    return results;
  }

  async clearRiskAction(id: string, actor: { role: string; ref: string }) {
    const db = this.env.IDENTITY_DB;
    const res = await db.prepare(`UPDATE enrollment_risk_actions SET expires_at = ?1 WHERE id = ?2`).bind(nowIso(), id).run();
    await db
      .prepare(`INSERT INTO identity_audit (id, action, actor_role, actor_ref, case_ref, created_at, summary) VALUES (?1, 'RISK_ACTION_CLEARED', ?2, ?3, ?4, ?5, '{}')`)
      .bind(crypto.randomUUID(), actor.role, actor.ref, id, nowIso())
      .run();
    return { ok: res.meta.changes === 1 };
  }

  async runTrustScreening() {
    return runTrustScreening(this.env);
  }

  async audit() {
    const { results } = await this.env.IDENTITY_DB.prepare(`SELECT * FROM identity_audit ORDER BY created_at DESC LIMIT 100`).all();
    return results;
  }
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const p = url.pathname;
  const m = request.method;

  if (p === "/" && m === "GET") {
    return htmlPage("Accounts", `<h1>GovZones accounts</h1><p>Sign-in for GovZones voting passes. <a href="${escapeHtml(parseOrigins(env.PUBLIC_ORIGINS)[0] ?? "/")}/ph">Go to GovZones</a></p>`);
  }
  if (p === "/api/v1/auth/email/start" && m === "POST") return emailStart(request, env);
  if (p === "/api/v1/auth/email/verify" && m === "POST") return emailVerify(request, env);
  if (p === "/auth/logout" && m === "POST") return logout(request, env);

  if (p === "/api/v1/session" && m === "GET") return sessionInfo(request, env);
  if (p === "/api/v1/wallet/enroll" && m === "POST") return enroll(request, env, ctx);
  if (p === "/api/v1/wallet/backup") {
    if (m === "GET") return getBackup(request, env);
    if (m === "PUT") return putBackup(request, env);
    if (m === "DELETE") return deleteBackup(request, env);
  }
  if (p === "/api/v1/wallet/reset-request" && m === "POST") return resetRequest(request, env);
  if (p === "/api/v1/me" && m === "DELETE") return deleteAccount(request, env);
  if (p === "/api/v1/entities/suggestions" && m === "POST") return suggest(request, env);
  const corr = p.match(/^\/api\/v1\/entities\/([0-9a-f-]{36})\/corrections$/);
  if (corr && m === "POST") return correction(request, env, corr[1]);
  throw new HttpError("NOT_FOUND");
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, parseOrigins(env.PUBLIC_ORIGINS), CORS_OPTS);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env, ctx);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    } catch (err) {
      return errorResponse(err, cors);
    }
  },
  async scheduled(_c, env, ctx) {
    ctx.waitUntil(Promise.all([runTrustScreening(env), purgeExpiredCodes(env.IDENTITY_DB)]).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
