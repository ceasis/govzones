/**
 * GovZones Anonymous Ballot Worker — served exclusively at vote.govzones.com.
 *
 * Authenticates a zero-knowledge group-membership proof, never a logged-in account.
 * Rejects cookies, Authorization headers and identifying Referers. Stores no IPs.
 */
import {
  ballotMessage,
  entityScope,
  isUuid,
  isValidScore,
  type BallotOperation,
} from "../../shared/protocol";
import { verifySemaphoreProof, isWellFormedProof, type SemaphoreProofPayload } from "../../shared/zk/verify";
import { HttpError, corsHeaders, errorResponse, json, nowIso, parseOrigins, readJson } from "../../shared/http";
import { randomToken, sha256Hex } from "../../shared/signing";
import { SCORING } from "../../shared/scoring";
import { acceptedRoots, resolveRoot } from "./roots";
import type { AggregateEvent, Env } from "./env";
import { consumeChallenge, type CommitResult } from "./coordinator";

export { BallotCoordinator } from "./coordinator";
export { BallotModeration } from "./moderation";

const CORS_OPTS = { credentials: false, methods: "GET, POST, PUT, DELETE, OPTIONS", headers: "Content-Type" };

interface BallotBody {
  entityId?: unknown;
  operation?: unknown;
  score?: unknown;
  scope?: unknown;
  nullifier?: unknown;
  groupRoot?: unknown;
  challenge?: unknown;
  proof?: unknown;
  receipt?: unknown;
}

/** Requests must carry no ambient credentials or identifying referrer. */
function assertAnonymousRequest(request: Request) {
  if (request.headers.has("Cookie") || request.headers.has("Authorization")) {
    throw new HttpError("CREDENTIALS_NOT_ALLOWED", "This endpoint does not accept cookies or credentials.");
  }
  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      const u = new URL(referer);
      if ((u.pathname !== "/" && u.pathname !== "") || u.search) throw new Error();
    } catch {
      throw new HttpError("CREDENTIALS_NOT_ALLOWED", "Identifying Referer headers are not accepted.");
    }
  }
}

async function requireRatableEntity(env: Env, entityId: string) {
  const row = await env.DIRECTORY.prepare(`SELECT country_code, status, ratable FROM entities WHERE id = ?1`)
    .bind(entityId)
    .first<{ country_code: string; status: string; ratable: number }>();
  if (!row || row.country_code !== env.COUNTRY_CODE || row.status !== "ACTIVE" || row.ratable !== 1) {
    throw new HttpError("ENTITY_NOT_RATABLE");
  }
}

async function issueChallenge(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ entityId?: unknown; operation?: unknown }>(request, 1024);
  const entityId = body.entityId;
  const operation = body.operation as BallotOperation;
  if (!isUuid(entityId)) throw new HttpError("BAD_REQUEST", "Invalid entity.");
  if (!["UPSERT", "DELETE", "APPEAL"].includes(operation)) throw new HttpError("BAD_REQUEST", "Invalid operation.");
  if (operation === "UPSERT") await requireRatableEntity(env, entityId);

  if (env.CHALLENGE_LIMITER) {
    // Ephemeral, location-local throttle. The key is never stored by GovZones.
    const key = request.headers.get("CF-Connecting-IP") ?? "local";
    const { success } = await env.CHALLENGE_LIMITER.limit({ key });
    if (!success) throw new HttpError("RATE_LIMITED");
  }

  const now = Date.now();
  const ttl = Number(env.CHALLENGE_TTL_SECONDS ?? 300) * 1000;
  const challenge = randomToken(32);
  await env.VOTES_DB.prepare(
    `INSERT INTO proof_challenges (challenge_hash, entity_id, operation, issued_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(await sha256Hex(challenge), entityId, operation, nowIso(now), nowIso(now + ttl))
    .run();
  return json({ challenge, expiresAt: nowIso(now + ttl) });
}

interface VerifiedBallot {
  entityId: string;
  operation: BallotOperation;
  score: number | null;
  nullifier: string;
  challengeHash: string;
  root: Awaited<ReturnType<typeof acceptedRoots>>[number];
}

/**
 * Independent validation of everything the client claims: entity/scope binding,
 * operation/score/challenge message binding, approved signed root, proof depth,
 * challenge freshness, and finally the Groth16 proof itself.
 */
async function verifyBallotRequest(
  env: Env,
  pathEntityId: string,
  body: BallotBody,
  expectedOp: BallotOperation,
): Promise<VerifiedBallot> {
  if (!isUuid(pathEntityId) || body.entityId !== pathEntityId) throw new HttpError("BAD_REQUEST", "Entity mismatch.");
  const entityId = pathEntityId;
  if (body.operation !== expectedOp) throw new HttpError("BAD_REQUEST", "Operation mismatch.");

  let score: number | null = null;
  if (expectedOp === "UPSERT") {
    if (!isValidScore(body.score)) throw new HttpError("INVALID_SCORE");
    score = body.score;
  } else if (body.score !== undefined && body.score !== null) {
    throw new HttpError("INVALID_SCORE", "A score is only allowed when rating.");
  }
  if (expectedOp === "UPSERT") await requireRatableEntity(env, entityId);

  if (typeof body.challenge !== "string" || body.challenge.length < 16 || body.challenge.length > 128) {
    throw new HttpError("EXPIRED_CHALLENGE");
  }
  const challenge = body.challenge;
  if (!isWellFormedProof(body.proof)) throw new HttpError("INVALID_PROOF");
  const proof = body.proof as SemaphoreProofPayload;

  const scope = entityScope(env.COUNTRY_CODE, entityId).toString();
  if (proof.scope !== scope || body.scope !== scope) throw new HttpError("INVALID_PROOF", "Scope mismatch.");
  const message = ballotMessage({ operation: expectedOp, entityId, score, challenge }).toString();
  if (proof.message !== message) throw new HttpError("INVALID_PROOF", "Message binding mismatch.");
  if (body.nullifier !== proof.nullifier || body.groupRoot !== proof.merkleTreeRoot) {
    throw new HttpError("INVALID_PROOF", "Public signal mismatch.");
  }

  const root = await resolveRoot(env, env.COUNTRY_CODE, proof.merkleTreeRoot);
  if (!root) throw new HttpError("UNAPPROVED_GROUP_ROOT");
  if (proof.merkleTreeDepth !== root.proofDepth) throw new HttpError("INVALID_PROOF", "Unexpected proof depth.");

  // Cheap challenge pre-check before spending CPU on pairing checks.
  const challengeHash = await sha256Hex(challenge);
  const ch = await env.VOTES_DB.prepare(
    `SELECT entity_id, operation, expires_at, used_at FROM proof_challenges WHERE challenge_hash = ?1`,
  )
    .bind(challengeHash)
    .first<{ entity_id: string; operation: string; expires_at: string; used_at: string | null }>();
  if (!ch) throw new HttpError("EXPIRED_CHALLENGE");
  if (ch.used_at) throw new HttpError("REPLAYED_CHALLENGE");
  if (Date.parse(ch.expires_at) <= Date.now()) throw new HttpError("EXPIRED_CHALLENGE");
  if (ch.entity_id !== entityId || ch.operation !== expectedOp) throw new HttpError("INVALID_PROOF", "Challenge mismatch.");

  if (!verifySemaphoreProof(proof)) throw new HttpError("INVALID_PROOF");
  return { entityId, operation: expectedOp, score, nullifier: proof.nullifier, challengeHash, root };
}

function commitError(result: Extract<CommitResult, { ok: false }>): never {
  throw new HttpError(result.code, undefined, result.nextEditableAt ? { nextEditableAt: result.nextEditableAt } : undefined);
}

async function enqueueRecompute(env: Env, entityId: string) {
  const event: AggregateEvent = { eventId: crypto.randomUUID(), country: env.COUNTRY_CODE, entityId, reason: "ballot_write" };
  await env.AGGREGATE_QUEUE.send(event);
}

async function handleBallotWrite(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  entityId: string,
  op: "UPSERT" | "DELETE",
): Promise<Response> {
  const body = await readJson<BallotBody>(request, 8192);
  const v = await verifyBallotRequest(env, entityId, body, op);
  const stub = env.BALLOT_COORDINATOR.get(env.BALLOT_COORDINATOR.idFromName(`${env.COUNTRY_CODE}:${v.entityId}`));
  const result = await stub.commit({
    country: env.COUNTRY_CODE,
    entityId: v.entityId,
    operation: op,
    score: v.score,
    nullifier: v.nullifier,
    challengeHash: v.challengeHash,
    trustGroup: v.root.group,
    rootEpoch: v.root.epoch,
    rootAnonymityOk: v.root.anonymityOk,
  });
  if (!result.ok) commitError(result);
  if (result.touched) ctx.waitUntil(enqueueRecompute(env, v.entityId));
  // Acknowledgment never reveals whether screening will count this ballot.
  if (result.status === "deleted") return json({ status: "deleted" });
  return json({ status: "submitted", receipt: result.receipt, nextEditableAt: result.nextEditableAt });
}

/** Wallet-held status lookup by entity-scoped nullifier (POST body; never in URLs). */
async function handleStatus(request: Request, env: Env, entityId: string): Promise<Response> {
  if (!isUuid(entityId)) throw new HttpError("BAD_REQUEST");
  const body = await readJson<{ nullifier?: unknown }>(request, 1024);
  if (typeof body.nullifier !== "string" || !/^[0-9]{1,78}$/.test(body.nullifier)) throw new HttpError("BAD_REQUEST");
  const row = await env.VOTES_DB.prepare(
    `SELECT status, last_scored_at FROM anonymous_ballots WHERE country_code = ?1 AND entity_id = ?2 AND scoped_nullifier = ?3`,
  )
    .bind(env.COUNTRY_CODE, entityId, body.nullifier)
    .first<{ status: string; last_scored_at: string }>();
  return json(publicBallotStatus(env, row));
}

function publicBallotStatus(env: Env, row: { status: string; last_scored_at: string } | null) {
  if (!row) return { status: "none" };
  const nextEditableAt = nowIso(
    Date.parse(row.last_scored_at) + Number(env.COOLDOWN_DAYS ?? SCORING.cooldownDays) * 86_400_000,
  );
  // Only "submitted" or "deleted": the internal screening state is never disclosed.
  return { status: row.status === "DELETED" ? "deleted" : "submitted", nextEditableAt };
}

async function handleReceiptLookup(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ receipt?: unknown }>(request, 1024);
  if (typeof body.receipt !== "string" || body.receipt.length < 16 || body.receipt.length > 128) {
    throw new HttpError("NOT_FOUND");
  }
  const row = await env.VOTES_DB.prepare(
    `SELECT b.status, b.last_scored_at FROM ballot_receipts r JOIN anonymous_ballots b ON b.id = r.ballot_id
       WHERE r.receipt_hash = ?1`,
  )
    .bind(await sha256Hex(body.receipt))
    .first<{ status: string; last_scored_at: string }>();
  if (!row) throw new HttpError("NOT_FOUND");
  return json(publicBallotStatus(env, row));
}

/** Anonymous appeal: wallet-held receipt + fresh ZK proof of the same entity nullifier. */
async function handleAppeal(request: Request, env: Env): Promise<Response> {
  const body = await readJson<BallotBody>(request, 8192);
  if (typeof body.receipt !== "string" || !isUuid(body.entityId)) throw new HttpError("BAD_REQUEST");
  const v = await verifyBallotRequest(env, body.entityId, body, "APPEAL");
  const ballot = await env.VOTES_DB.prepare(
    `SELECT b.id, b.entity_id, b.scoped_nullifier, b.status FROM ballot_receipts r
       JOIN anonymous_ballots b ON b.id = r.ballot_id WHERE r.receipt_hash = ?1`,
  )
    .bind(await sha256Hex(body.receipt))
    .first<{ id: string; entity_id: string; scoped_nullifier: string; status: string }>();
  if (!ballot || ballot.entity_id !== v.entityId || ballot.scoped_nullifier !== v.nullifier) {
    throw new HttpError("INVALID_PROOF", "This proof does not match the receipt.");
  }
  const consumed = await consumeChallenge(env.VOTES_DB, v.challengeHash, v.entityId, "APPEAL", Date.now());
  if (consumed !== "ok") throw new HttpError(consumed);

  const ts = nowIso();
  let caseId: string | null = null;
  if (ballot.status === "QUARANTINED" || ballot.status === "EXCLUDED") {
    const c = await env.VOTES_DB.prepare(
      `SELECT case_id FROM ballot_risk_cases WHERE ballot_id = ?1 AND state IN ('OPEN', 'EXCLUDED') ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(ballot.id)
      .first<{ case_id: string }>();
    if (c) {
      caseId = c.case_id;
      await env.VOTES_DB.prepare(`UPDATE ballot_risk_cases SET state = 'APPEALED' WHERE case_id = ?1`).bind(caseId).run();
    }
  }
  await env.VOTES_DB.prepare(`INSERT INTO ballot_appeals (id, ballot_id, case_id, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(crypto.randomUUID(), ballot.id, caseId, ts)
    .run();
  // Identical response whatever the ballot's internal state.
  return json({ status: "appeal_received" });
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/anonymous/v1/health" && request.method === "GET") return json({ ok: true });
  if (path === "/anonymous/v1/challenges" && request.method === "POST") return issueChallenge(request, env);
  if (path === "/anonymous/v1/receipts/lookup" && request.method === "POST") return handleReceiptLookup(request, env);
  if (path === "/anonymous/v1/appeals" && request.method === "POST") return handleAppeal(request, env);

  const ballot = path.match(/^\/anonymous\/v1\/ballots\/([0-9a-f-]{36})$/);
  if (ballot) {
    if (request.method === "PUT") return handleBallotWrite(request, env, ctx, ballot[1], "UPSERT");
    if (request.method === "DELETE") return handleBallotWrite(request, env, ctx, ballot[1], "DELETE");
    throw new HttpError("METHOD_NOT_ALLOWED");
  }
  const status = path.match(/^\/anonymous\/v1\/ballots\/([0-9a-f-]{36})\/status$/);
  if (status && request.method === "POST") return handleStatus(request, env, status[1]);
  throw new HttpError("NOT_FOUND");
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, parseOrigins(env.PUBLIC_ORIGINS), CORS_OPTS);
    const extra = { ...cors, "Cache-Control": "no-store" };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      assertAnonymousRequest(request);
      const res = await route(request, env, ctx);
      for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
      return res;
    } catch (err) {
      return errorResponse(err, extra);
    }
  },
} satisfies ExportedHandler<Env>;
