/**
 * Signed group-root records (ECDSA P-256 / SHA-256 over canonical JSON) via WebCrypto.
 * Works identically in Workers, browsers and Node >= 20.
 */
import type { GroupId } from "./protocol";

export interface RootRecord {
  v: 1;
  country: string;
  group: GroupId;
  epoch: number;
  root: string;
  memberCount: number;
  leafCount: number;
  proofDepth: number;
  anonymityOk: boolean;
  validFrom: string;
  validUntil: string;
  snapshotSha256: string;
}

export interface SignedRoot {
  record: RootRecord;
  payload: string;
  signature: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
}

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALG = { name: "ECDSA", hash: "SHA-256" } as const;

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importSigningKey(jwkJson: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", JSON.parse(jwkJson), ALG, false, ["sign"]);
}

export async function importVerifyKey(jwkJson: string): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkJson);
  delete jwk.d;
  jwk.key_ops = ["verify"];
  return crypto.subtle.importKey("jwk", jwk, ALG, false, ["verify"]);
}

export async function signRecord(record: RootRecord, key: CryptoKey): Promise<SignedRoot> {
  const payload = canonicalJson(record);
  const sig = await crypto.subtle.sign(SIGN_ALG, key, new TextEncoder().encode(payload));
  return { record, payload, signature: base64UrlEncode(sig) };
}

export async function verifySignedRoot(signed: SignedRoot, key: CryptoKey): Promise<boolean> {
  try {
    if (canonicalJson(signed.record) !== signed.payload) return false;
    return await crypto.subtle.verify(
      SIGN_ALG,
      key,
      base64UrlDecode(signed.signature),
      new TextEncoder().encode(signed.payload),
    );
  } catch {
    return false;
  }
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}
