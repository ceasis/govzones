/**
 * Admin authentication: Cloudflare Access JWT (Cf-Access-Jwt-Assertion) + explicit role map.
 * There is no public admin login route. Local development may use an explicit bypass that is
 * refused on any non-localhost hostname.
 */
import { base64UrlDecode } from "../../shared/signing";

export type Role = "curator" | "moderator" | "sysadmin";
export const ROLES: Role[] = ["curator", "moderator", "sysadmin"];

export interface AdminAuthEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** JSON: { "staff@example.org": ["curator", "moderator"] } */
  ADMIN_ROLES?: string;
  ADMIN_DEV_BYPASS?: string;
}

export interface Staff {
  ref: string;
  roles: Role[];
  dev: boolean;
}

let certs: { at: number; keys: Array<{ kid: string; kty: string; n: string; e: string }> } | null = null;

async function accessKeys(team: string) {
  if (certs && Date.now() - certs.at < 3_600_000) return certs.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("access certs unavailable");
  const body = (await res.json()) as { keys: Array<{ kid: string; kty: string; n: string; e: string }> };
  certs = { at: Date.now(), keys: body.keys };
  return body.keys;
}

async function verifyAccessJwt(env: AdminAuthEnv, token: string): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as { kid: string; alg: string };
  if (header.alg !== "RS256") return null;
  const jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;
  const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))) as {
    aud: string | string[];
    iss: string;
    exp: number;
    email?: string;
  };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (claims.exp < Date.now() / 1000) return null;
  return claims.email ?? null;
}

function readCookie(request: Request, name: string) {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export async function authenticate(request: Request, env: AdminAuthEnv): Promise<Staff | null> {
  const host = new URL(request.url).hostname;
  if (env.ADMIN_DEV_BYPASS === "1" && (host === "localhost" || host.endsWith(".localhost"))) {
    const picked = (readCookie(request, "gz_admin_roles") ?? "curator,moderator,sysadmin")
      .split(",")
      .filter((r): r is Role => (ROLES as string[]).includes(r));
    return { ref: "dev-staff", roles: picked, dev: true };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const email = await verifyAccessJwt(env, token);
  if (!email) return null;
  const map = JSON.parse(env.ADMIN_ROLES ?? "{}") as Record<string, Role[]>;
  const roles = (map[email.toLowerCase()] ?? []).filter((r) => ROLES.includes(r));
  if (roles.length === 0) return null;
  // Audit trails store a hashed staff reference rather than the raw e-mail.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.toLowerCase()));
  const ref = "staff-" + [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { ref, roles, dev: false };
}
