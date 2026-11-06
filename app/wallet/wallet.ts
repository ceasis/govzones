/**
 * The private voting wallet. Lives only in this browser (encrypted in IndexedDB) and,
 * optionally, as ciphertext in a user-held backup. It holds:
 *  - one random Semaphore identity per country (the secret never leaves the device),
 *  - the user's OWN rated-entity list (there is no server-side account → rating index).
 */
import { kv } from "./store";
import {
  deriveBackupKey,
  encodeEnvelope,
  newDeviceKey,
  newSalt,
  openBackup,
  seal,
  sealBackup,
  unseal,
  decodeEnvelope,
  type Sealed,
} from "./crypto";

export type RatingStatus = "submitted" | "deleted";

export interface WalletRating {
  entityId: string;
  country: string;
  name: string;
  path: string;
  score: number;
  status: RatingStatus;
  submittedAt: string;
  nextEditableAt: string | null;
  receipt: string | null;
  /** Which group the last proof came from; lets the wallet re-prove later to upgrade trust. */
  provenGroup: "submit" | "countable";
  provenAnonymityOk: boolean;
  /** Randomised time for an automatic same-score re-proof after a trust upgrade. */
  upgradeAfter?: string | null;
}

export interface PendingAction {
  entityId: string;
  country: string;
  name: string;
  path: string;
  operation: "UPSERT" | "DELETE";
  score: number | null;
  queuedAt: string;
  notBefore: string;
}

export interface WalletData {
  v: 1;
  createdDay: string;
  identities: Record<string, { privateKey: string; commitment: string; enrolled: boolean }>;
  ratings: Record<string, WalletRating>;
  pending: Record<string, PendingAction>;
  backup: { version: number; dirty: boolean; lastUploadedDay: string | null };
  recoveryConfirmed: boolean;
}

const K_WALLET = "wallet";
const K_DEVICE = "deviceKey";
const K_BACKUP_KEY = "backupKey";
const K_SALT = "backupSalt";

export function emptyWallet(): WalletData {
  return {
    v: 1,
    createdDay: new Date().toISOString().slice(0, 10),
    identities: {},
    ratings: {},
    pending: {},
    backup: { version: 0, dirty: true, lastUploadedDay: null },
    recoveryConfirmed: false,
  };
}

export async function hasWallet(): Promise<boolean> {
  return Boolean(await kv.get<Sealed>(K_WALLET));
}

export async function loadWallet(): Promise<WalletData | null> {
  const sealed = await kv.get<Sealed>(K_WALLET);
  const key = await kv.get<CryptoKey>(K_DEVICE);
  if (!sealed || !key) return null;
  return JSON.parse(await unseal(key, sealed)) as WalletData;
}

export async function saveWallet(w: WalletData): Promise<void> {
  let key = await kv.get<CryptoKey>(K_DEVICE);
  if (!key) {
    key = await newDeviceKey();
    await kv.set(K_DEVICE, key);
  }
  await kv.set(K_WALLET, await seal(key, JSON.stringify(w)));
}

/** Creates the wallet and binds the backup key to a fresh recovery key. */
export async function createWallet(recoveryKey: string): Promise<WalletData> {
  const salt = newSalt();
  await kv.set(K_SALT, salt);
  await kv.set(K_BACKUP_KEY, await deriveBackupKey(recoveryKey, salt));
  const w = emptyWallet();
  await saveWallet(w);
  return w;
}

/** Returns the opaque encrypted backup string (for the account server or a downloaded file). */
export async function exportBackup(w: WalletData): Promise<string> {
  const key = await kv.get<CryptoKey>(K_BACKUP_KEY);
  const salt = await kv.get<Uint8Array>(K_SALT);
  if (!key || !salt) throw new Error("Backup key missing on this device. Restore with your recovery key first.");
  return encodeEnvelope(await sealBackup(key, salt, JSON.stringify(w)));
}

export async function restoreFromBackup(envelopeString: string, recoveryKey: string): Promise<WalletData> {
  const envelope = decodeEnvelope(envelopeString);
  if (!envelope) throw new Error("This is not a GovZones wallet backup.");
  let opened;
  try {
    opened = await openBackup(envelope, recoveryKey);
  } catch {
    throw new Error("The recovery key does not match this backup.");
  }
  const w = JSON.parse(opened.plaintext) as WalletData;
  if (w.v !== 1) throw new Error("Unsupported wallet version.");
  await kv.set(K_SALT, opened.salt);
  await kv.set(K_BACKUP_KEY, opened.key);
  w.recoveryConfirmed = true;
  await saveWallet(w);
  return w;
}

/** Removes the wallet from this device only (backups and past ballots are untouched). */
export async function forgetWallet(): Promise<void> {
  await kv.clear();
}

export function ratingList(w: WalletData | null): WalletRating[] {
  return w ? Object.values(w.ratings).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)) : [];
}
