/**
 * Wallet encryption (browser WebCrypto only; no custom primitives).
 *
 * - Recovery key: 160 random bits shown to the user as 8 groups of base32 characters.
 * - Backup key: PBKDF2-SHA256 (600k iterations) over the recovery key → AES-256-GCM.
 * - Device key: random, NON-extractable AES-256-GCM key kept in IndexedDB for convenient
 *   local unlock. The server never receives either key.
 */

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ0123456789"; // Crockford-style, no I/L/O/U
const PBKDF2_ITERATIONS = 600_000;
const PAD_BLOCK = 4096;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function generateRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join("-");
}

export function normalizeRecoveryKey(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== 32 || [...cleaned].some((c) => !ALPHABET.includes(c))) return null;
  return cleaned.match(/.{4}/g)!.join("-");
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveBackupKey(
  recoveryKey: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(recoveryKey), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function newDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Pads to a 4 KiB multiple so ciphertext size reveals little about how many ratings exist. */
function pad(plaintext: string): Uint8Array<ArrayBuffer> {
  const body = enc.encode(plaintext);
  const total = Math.ceil((body.length + 4) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  crypto.getRandomValues(out.subarray(4 + body.length));
  return out;
}

function unpad(bytes: Uint8Array): string {
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, false);
  return dec.decode(bytes.subarray(4, 4 + len));
}

export interface Sealed {
  iv: string;
  ct: string;
}

export async function seal(key: CryptoKey, plaintext: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pad(plaintext));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function unseal(key: CryptoKey, sealed: Sealed): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, key, unb64(sealed.ct));
  return unpad(new Uint8Array(pt));
}

export interface BackupEnvelope {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

/** Opaque string form (URL-safe) used for server backups and exported files. */
export function encodeEnvelope(e: BackupEnvelope): string {
  return b64(enc.encode(JSON.stringify(e)));
}

export function decodeEnvelope(s: string): BackupEnvelope | null {
  try {
    const e = JSON.parse(dec.decode(unb64(s.trim()))) as BackupEnvelope;
    return e.v === 1 && e.kdf === "PBKDF2-SHA256" ? e : null;
  } catch {
    return null;
  }
}

export async function sealBackup(key: CryptoKey, salt: Uint8Array, plaintext: string): Promise<BackupEnvelope> {
  const s = await seal(key, plaintext);
  return { v: 1, kdf: "PBKDF2-SHA256", iter: PBKDF2_ITERATIONS, salt: b64(salt), ...s };
}

export async function openBackup(envelope: BackupEnvelope, recoveryKey: string): Promise<{ plaintext: string; key: CryptoKey; salt: Uint8Array }> {
  const salt = unb64(envelope.salt);
  // Never accept a weaker KDF than the current policy from an imported envelope.
  const key = await deriveBackupKey(recoveryKey, salt, Math.max(PBKDF2_ITERATIONS, envelope.iter));
  return { plaintext: await unseal(key, envelope), key, salt };
}

export function newSalt(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(16));
}
