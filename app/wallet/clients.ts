/**
 * Network clients for the three GovZones hosts. Strict separation:
 *  - accounts.*  : credentials included (host-only session cookie), CSRF header; never sees ratings.
 *  - vote.*      : credentials OMITTED, no referrer, no identifiers; authenticated only by ZK proofs.
 *  - govzones.com: public group roots/snapshots (identical for every visitor).
 */
import { ballotMessage, entityScope, type BallotOperation } from "../../shared/protocol";
import { importVerifyKey, sha256Hex, verifySignedRoot, type RootRecord, type SignedRoot } from "../../shared/signing";
import { prove, type ProofStage } from "./prover";
import type { PublicConfig } from "../lib/config";

/* ---------------- accounts host ---------------- */

export interface SessionInfo {
  signedIn: boolean;
  csrfToken?: string;
  enrollments?: Array<{ country: string; commitment: string }>;
  backup?: { version: number; updatedDay: string } | null;
  resetRequests?: Array<{ country: string; status: string }>;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function parse(res: Response) {
  const body = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } } & Record<string, unknown>;
  if (!res.ok) {
    const { code = "INTERNAL", message = "Request failed.", ...extra } = body.error ?? {};
    throw new ApiError(code, message, res.status, extra);
  }
  return body;
}

let csrfToken: string | null = null;

export async function fetchSession(cfg: PublicConfig): Promise<SessionInfo> {
  const res = await fetch(`${cfg.accountsOrigin}/api/v1/session`, { credentials: "include", cache: "no-store" });
  const body = (await parse(res)) as unknown as SessionInfo;
  csrfToken = body.csrfToken ?? null;
  return body;
}

export async function accountsCall<T = Record<string, unknown>>(
  cfg: PublicConfig,
  path: string,
  method: "POST" | "PUT" | "DELETE" | "GET",
  body?: unknown,
): Promise<T> {
  if (!csrfToken && method !== "GET") await fetchSession(cfg);
  const res = await fetch(`${cfg.accountsOrigin}${path}`, {
    method,
    credentials: "include",
    cache: "no-store",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await parse(res)) as T;
}

/* E-mail code sign-in: both calls are unauthenticated; the verify response sets the session cookie. */

export async function requestEmailCode(cfg: PublicConfig, email: string): Promise<{ devCode?: string }> {
  const res = await fetch(`${cfg.accountsOrigin}/api/v1/auth/email/start`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return (await parse(res)) as { devCode?: string };
}

export async function verifyEmailCode(cfg: PublicConfig, email: string, code: string): Promise<void> {
  const res = await fetch(`${cfg.accountsOrigin}/api/v1/auth/email/verify`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  await parse(res);
  csrfToken = null; // a fresh session: the next call fetches its CSRF token
}

/* ---------------- public group roots ---------------- */

export interface AcceptedRoot extends RootRecord {
  snapshotPath: string;
}

let verifyKey: CryptoKey | null = null;
const snapshotCache = new Map<string, string[]>();

export async function loadRoots(cfg: PublicConfig, country: string): Promise<AcceptedRoot[]> {
  verifyKey ??= await importVerifyKey(cfg.rootPublicKey);
  const res = await fetch(`/api/v1/groups/roots?country=${country}`, { credentials: "omit", cache: "no-store" });
  const body = (await parse(res)) as unknown as { roots: Array<SignedRoot & { snapshotPath: string }> };
  const out: AcceptedRoot[] = [];
  for (const r of body.roots) {
    // Roots must carry a valid signature from the pinned GovZones root key.
    if (r.record.country === country && (await verifySignedRoot(r, verifyKey))) out.push({ ...r.record, snapshotPath: r.snapshotPath });
  }
  return out;
}

async function snapshotLeaves(root: AcceptedRoot): Promise<string[]> {
  const cached = snapshotCache.get(root.root);
  if (cached) return cached;
  const res = await fetch(root.snapshotPath, { credentials: "omit" });
  if (!res.ok) throw new ApiError("SNAPSHOT_UNAVAILABLE", "Could not load the voting group data. Please try again.", res.status);
  const text = await res.text();
  if ((await sha256Hex(text)) !== root.snapshotSha256) throw new ApiError("SNAPSHOT_INTEGRITY", "The voting group data did not pass its safety check, so nothing was sent.", 500);
  const leaves = (JSON.parse(text) as { leaves: string[] }).leaves;
  snapshotCache.set(root.root, leaves);
  return leaves;
}

export interface Membership {
  root: AcceptedRoot;
  leaves: string[];
}

/** Prefers a counted-eligible Countable root, then any Countable root, then the Submit root (latest epoch first). */
export async function findMembership(roots: AcceptedRoot[], commitment: string): Promise<Membership | null> {
  const rank = (r: AcceptedRoot) => (r.group === "countable" ? (r.anonymityOk ? 0 : 1) : 2);
  const ordered = [...roots].sort((a, b) => rank(a) - rank(b) || b.epoch - a.epoch);
  for (const root of ordered) {
    const leaves = await snapshotLeaves(root);
    if (leaves.includes(commitment)) return { root, leaves };
  }
  return null;
}

/* ---------------- anonymous ballot host ---------------- */

async function vote<T>(cfg: PublicConfig, path: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`${cfg.voteOrigin}${path}`, {
    method,
    mode: "cors",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await parse(res)) as T;
}

export interface BallotAck {
  status: "submitted" | "deleted";
  receipt?: string;
  nextEditableAt?: string;
}

export interface CastInput {
  cfg: PublicConfig;
  country: string;
  entityId: string;
  operation: Exclude<BallotOperation, "APPEAL">;
  score: number | null;
  identity: { privateKey: string; commitment: string };
  onStage?: (s: ProofStage | "challenge" | "membership" | "submitting") => void;
  signal?: AbortSignal;
}

export class MembershipPendingError extends Error {
  constructor() {
    super("Your voting pass is not active yet.");
  }
}

export async function castBallot(input: CastInput): Promise<BallotAck & { group: "submit" | "countable"; anonymityOk: boolean }> {
  const { cfg, country, entityId, operation, score, identity } = input;
  input.onStage?.("membership");
  const roots = await loadRoots(cfg, country);
  const membership = await findMembership(roots, identity.commitment);
  if (!membership) throw new MembershipPendingError();

  input.onStage?.("challenge");
  const { challenge } = await vote<{ challenge: string }>(cfg, "/anonymous/v1/challenges", "POST", { entityId, operation });
  const scope = entityScope(country, entityId).toString();
  const message = ballotMessage({ operation, entityId, score, challenge }).toString();
  const proof = await prove(
    { privateKey: identity.privateKey, leaves: membership.leaves, depth: membership.root.proofDepth, message, scope },
    (s) => input.onStage?.(s),
    input.signal,
  );
  input.onStage?.("submitting");
  const ack = await vote<BallotAck>(cfg, `/anonymous/v1/ballots/${entityId}`, operation === "DELETE" ? "DELETE" : "PUT", {
    entityId,
    operation,
    ...(operation === "UPSERT" ? { score } : {}),
    scope,
    nullifier: proof.nullifier,
    groupRoot: proof.merkleTreeRoot,
    challenge,
    proof,
  });
  return { ...ack, group: membership.root.group, anonymityOk: membership.root.anonymityOk };
}

export async function receiptStatus(cfg: PublicConfig, receipt: string) {
  return vote<{ status: "submitted" | "deleted" | "none"; nextEditableAt?: string }>(cfg, "/anonymous/v1/receipts/lookup", "POST", { receipt });
}

export async function nullifierStatus(cfg: PublicConfig, country: string, entityId: string, privateKey: string) {
  const [{ Identity }, { computeNullifier }] = await Promise.all([import("@semaphore-protocol/identity"), import("../../shared/protocol")]);
  const nullifier = computeNullifier(Identity.import(privateKey).secretScalar, entityScope(country, entityId)).toString();
  return vote<{ status: "submitted" | "deleted" | "none"; nextEditableAt?: string }>(cfg, `/anonymous/v1/ballots/${entityId}/status`, "POST", { nullifier });
}

export async function submitAppeal(input: Omit<CastInput, "operation" | "score"> & { receipt: string }) {
  const { cfg, country, entityId, identity } = input;
  const roots = await loadRoots(cfg, country);
  const membership = await findMembership(roots, identity.commitment);
  if (!membership) throw new MembershipPendingError();
  const { challenge } = await vote<{ challenge: string }>(cfg, "/anonymous/v1/challenges", "POST", { entityId, operation: "APPEAL" });
  const scope = entityScope(country, entityId).toString();
  const message = ballotMessage({ operation: "APPEAL", entityId, challenge }).toString();
  const proof = await prove(
    { privateKey: identity.privateKey, leaves: membership.leaves, depth: membership.root.proofDepth, message, scope },
    (s) => input.onStage?.(s),
    input.signal,
  );
  return vote<{ status: string }>(cfg, "/anonymous/v1/appeals", "POST", {
    entityId,
    operation: "APPEAL",
    receipt: input.receipt,
    scope,
    nullifier: proof.nullifier,
    groupRoot: proof.merkleTreeRoot,
    challenge,
    proof,
  });
}
