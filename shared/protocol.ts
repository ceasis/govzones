/**
 * GovZones ballot protocol constants and domain-separated hashing.
 *
 * Shared by the browser wallet, the Anonymous Ballot Worker and tests so that
 * scope/message derivation can never drift between client and validator.
 * Any change here changes every nullifier and requires independent security review.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { poseidon2 } from "poseidon-lite/poseidon2";

/** BN254 scalar field order (the SNARK field used by Semaphore v4). */
export const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const PROTOCOL_VERSION = "govzones-zk-v1";
export const SCOPE_DOMAIN = "govzones-rating-v1";
export const BALLOT_DOMAIN = "govzones-ballot-v1";

/** Pinned Semaphore release whose circuits/artifacts/verification keys we accept. */
export const SEMAPHORE_VERSION = "4.14.5";
export const SEMAPHORE_ARTIFACTS_VERSION = "4.13.0";

/**
 * Proofs are generated at a fixed minimum tree depth so the client needs only a
 * handful of pinned artifacts. LeanIMT proofs pad missing siblings with zero.
 */
export const PROOF_DEPTH_FLOOR = 16;
export const MAX_PROOF_DEPTH = 32;

export type BallotOperation = "UPSERT" | "DELETE" | "APPEAL";
export const BALLOT_OPERATIONS: readonly BallotOperation[] = ["UPSERT", "DELETE", "APPEAL"];

export type GroupId = "submit" | "countable";

const encoder = new TextEncoder();

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt("0x" + (hex || "0"));
}

function bigIntTo32Bytes(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw new RangeError("value does not fit in 32 bytes");
  const hex = value.toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * H_to_field: SHA-256 over a length-prefixed encoding of each part, reduced mod the SNARK field.
 * Length prefixes make the encoding injective (no "ab"+"c" vs "a"+"bc" collisions).
 */
export function hashToField(...parts: string[]): bigint {
  const encoded = parts.map((p) => encoder.encode(p));
  const total = encoded.reduce((n, e) => n + 4 + e.length, 0);
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let offset = 0;
  for (const e of encoded) {
    view.setUint32(offset, e.length, false);
    buf.set(e, offset + 4);
    offset += 4 + e.length;
  }
  return bytesToBigInt(sha256(buf)) % SNARK_FIELD;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isCountryCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{2}$/.test(value);
}

/**
 * Unchanging per-entity scope. Deliberately excludes group root, date, trust tier and score,
 * so the same identity always produces the same nullifier for one entity and different,
 * unlinkable nullifiers for different entities.
 */
export function entityScope(countryCode: string, entityId: string): bigint {
  if (!isCountryCode(countryCode)) throw new TypeError("invalid country code");
  if (!isUuid(entityId)) throw new TypeError("invalid entity id");
  return hashToField(SCOPE_DOMAIN, countryCode, entityId);
}

export interface BallotMessageInput {
  operation: BallotOperation;
  entityId: string;
  score?: number | null;
  challenge: string;
}

/** Operation-bound message: binds op, entity, integer score (UPSERT only) and a one-time challenge. */
export function ballotMessage({ operation, entityId, score, challenge }: BallotMessageInput): bigint {
  if (!BALLOT_OPERATIONS.includes(operation)) throw new TypeError("invalid operation");
  if (!isUuid(entityId)) throw new TypeError("invalid entity id");
  if (operation === "UPSERT") {
    if (!isValidScore(score)) throw new TypeError("invalid score");
  } else if (score !== undefined && score !== null) {
    throw new TypeError("score only allowed for UPSERT");
  }
  if (typeof challenge !== "string" || challenge.length < 16) throw new TypeError("invalid challenge");
  return hashToField(BALLOT_DOMAIN, operation, entityId, operation === "UPSERT" ? String(score) : "", challenge);
}

export function isValidScore(score: unknown): score is number {
  return typeof score === "number" && Number.isInteger(score) && score >= 1 && score <= 10;
}

/**
 * Semaphore v4 hashes `message` and `scope` with keccak256(bytes32(value)) >> 8
 * before they become circuit public inputs. Reproduced here (pure JS) for the verifier.
 */
export function semaphoreHash(value: bigint | string): bigint {
  const v = typeof value === "bigint" ? value : BigInt(value);
  return bytesToBigInt(keccak_256(bigIntTo32Bytes(v))) >> 8n;
}

/**
 * Nullifier the circuit outputs: Poseidon(hash(scope), secretScalar).
 * Lets the wallet look up its own ballot status without generating a proof.
 */
export function computeNullifier(secretScalar: bigint | string, scope: bigint): bigint {
  return poseidon2([semaphoreHash(scope), BigInt(secretScalar)]);
}

/** Depth used to generate/verify proofs for a group with `leafCount` leaves. */
export function proofDepthFor(leafCount: number): number {
  const natural = leafCount <= 1 ? 1 : Math.ceil(Math.log2(leafCount));
  return Math.min(MAX_PROOF_DEPTH, Math.max(PROOF_DEPTH_FLOOR, natural));
}

export function isFieldElementString(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{1,78}$/.test(value)) return false;
  return BigInt(value) < SNARK_FIELD;
}
