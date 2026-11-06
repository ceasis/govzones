/**
 * Canonical ballot writes, serialized per entity by a Durable Object.
 *
 * Correctness does not depend on the DO alone: the votes table has a UNIQUE
 * (country, entity, nullifier) index and every update is revision-guarded,
 * so concurrent proofs can never create a second active ballot.
 */
import { DurableObject } from "cloudflare:workers";
import { SCORING } from "../../shared/scoring";
import { nowIso } from "../../shared/http";
import { randomToken, sha256Hex } from "../../shared/signing";
import type { BallotOperation, GroupId } from "../../shared/protocol";
import type { Env } from "./env";

export interface CommitInput {
  country: string;
  entityId: string;
  operation: Exclude<BallotOperation, "APPEAL">;
  score: number | null;
  nullifier: string;
  challengeHash: string;
  trustGroup: GroupId;
  rootEpoch: number;
  rootAnonymityOk: boolean;
}

export type CommitResult =
  | { ok: true; status: "submitted" | "deleted"; receipt: string | null; nextEditableAt: string | null; touched: boolean }
  | { ok: false; code: "EXPIRED_CHALLENGE" | "REPLAYED_CHALLENGE" | "VOTE_COOLDOWN" | "CONFLICT" | "NOT_FOUND"; nextEditableAt?: string };

interface BallotRow {
  id: string;
  score: number | null;
  status: string;
  trust_group: GroupId;
  root_anonymity_ok: number;
  last_scored_at: string;
  revision: number;
}

function cooldownMs(env: Env) {
  return Number(env.COOLDOWN_DAYS ?? SCORING.cooldownDays) * 86_400_000;
}

export async function consumeChallenge(
  db: D1Database,
  challengeHash: string,
  entityId: string,
  operation: BallotOperation,
  now: number,
): Promise<"ok" | "EXPIRED_CHALLENGE" | "REPLAYED_CHALLENGE"> {
  const used = await db
    .prepare(
      `UPDATE proof_challenges SET used_at = ?1
         WHERE challenge_hash = ?2 AND used_at IS NULL AND expires_at > ?1 AND entity_id = ?3 AND operation = ?4`,
    )
    .bind(nowIso(now), challengeHash, entityId, operation)
    .run();
  if (used.meta.changes === 1) return "ok";
  const row = await db
    .prepare(`SELECT used_at FROM proof_challenges WHERE challenge_hash = ?1`)
    .bind(challengeHash)
    .first<{ used_at: string | null }>();
  return row?.used_at ? "REPLAYED_CHALLENGE" : "EXPIRED_CHALLENGE";
}

async function issueReceipt(db: D1Database, ballotId: string, now: number): Promise<string> {
  const receipt = randomToken(24);
  await db
    .prepare(`INSERT INTO ballot_receipts (receipt_hash, ballot_id, created_at) VALUES (?1, ?2, ?3)`)
    .bind(await sha256Hex(receipt), ballotId, nowIso(now))
    .run();
  return receipt;
}

export async function commitBallot(env: Env, input: CommitInput, now = Date.now()): Promise<CommitResult> {
  const db = env.VOTES_DB;
  const challenge = await consumeChallenge(db, input.challengeHash, input.entityId, input.operation, now);
  if (challenge !== "ok") return { ok: false, code: challenge };

  const existing = await db
    .prepare(
      `SELECT id, score, status, trust_group, root_anonymity_ok, last_scored_at, revision FROM anonymous_ballots
         WHERE country_code = ?1 AND entity_id = ?2 AND scoped_nullifier = ?3`,
    )
    .bind(input.country, input.entityId, input.nullifier)
    .first<BallotRow>();
  const ts = nowIso(now);

  if (input.operation === "DELETE") {
    if (!existing || existing.status === "DELETED") {
      return { ok: true, status: "deleted", receipt: null, nextEditableAt: null, touched: false };
    }
    const res = await db
      .prepare(
        `UPDATE anonymous_ballots SET status = 'DELETED', score = NULL, updated_at = ?1, revision = revision + 1
           WHERE id = ?2 AND revision = ?3`,
      )
      .bind(ts, existing.id, existing.revision)
      .run();
    if (res.meta.changes !== 1) return { ok: false, code: "CONFLICT" };
    return { ok: true, status: "deleted", receipt: null, nextEditableAt: null, touched: true };
  }

  const score = input.score!;
  if (!existing) {
    const id = crypto.randomUUID();
    const res = await db
      .prepare(
        `INSERT INTO anonymous_ballots
           (id, country_code, entity_id, scoped_nullifier, score, status, trust_group, root_epoch, root_anonymity_ok,
            held_since, last_scored_at, created_at, updated_at, revision)
         VALUES (?1, ?2, ?3, ?4, ?5, 'PROVISIONAL', ?6, ?7, ?8, ?9, ?9, ?9, ?9, 1)
         ON CONFLICT (country_code, entity_id, scoped_nullifier) DO NOTHING`,
      )
      .bind(
        id,
        input.country,
        input.entityId,
        input.nullifier,
        score,
        input.trustGroup,
        input.rootEpoch,
        input.rootAnonymityOk ? 1 : 0,
        ts,
      )
      .run();
    if (res.meta.changes !== 1) return { ok: false, code: "CONFLICT" };
    return {
      ok: true,
      status: "submitted",
      receipt: await issueReceipt(db, id, now),
      nextEditableAt: nowIso(now + cooldownMs(env)),
      touched: true,
    };
  }

  const cooldownEnds = Date.parse(existing.last_scored_at) + cooldownMs(env);
  const active = existing.status !== "DELETED";
  const sameScore = active && existing.score === score;
  // Trust upgrade: same score re-proven from the Countable Group (or an anonymity-OK root)
  // promotes the one existing ballot; it never adds a second vote.
  const isPromotion =
    sameScore &&
    ((existing.trust_group === "submit" && input.trustGroup === "countable") ||
      (existing.root_anonymity_ok === 0 && input.rootAnonymityOk && input.trustGroup === "countable"));

  if (sameScore && !isPromotion) {
    return {
      ok: true,
      status: "submitted",
      receipt: await issueReceipt(db, existing.id, now),
      nextEditableAt: nowIso(cooldownEnds),
      touched: false,
    };
  }
  if (!isPromotion && now < cooldownEnds) {
    return { ok: false, code: "VOTE_COOLDOWN", nextEditableAt: nowIso(cooldownEnds) };
  }

  const scoreChanged = !sameScore;
  const res = await db
    .prepare(
      `UPDATE anonymous_ballots SET
          score = ?1,
          status = CASE WHEN status IN ('QUARANTINED', 'EXCLUDED') THEN status ELSE 'PROVISIONAL' END,
          trust_group = ?2,
          root_epoch = ?3,
          root_anonymity_ok = ?4,
          held_since = ?5,
          last_scored_at = CASE WHEN ?6 = 1 THEN ?5 ELSE last_scored_at END,
          updated_at = ?5,
          revision = revision + 1
        WHERE id = ?7 AND revision = ?8`,
    )
    .bind(
      score,
      input.trustGroup,
      input.rootEpoch,
      input.rootAnonymityOk ? 1 : 0,
      ts,
      scoreChanged ? 1 : 0,
      existing.id,
      existing.revision,
    )
    .run();
  if (res.meta.changes !== 1) return { ok: false, code: "CONFLICT" };
  return {
    ok: true,
    status: "submitted",
    receipt: await issueReceipt(db, existing.id, now),
    nextEditableAt: nowIso(scoreChanged ? now + cooldownMs(env) : cooldownEnds),
    touched: true,
  };
}

/** One instance per (country, entity): serializes hot-entity writes. */
export class BallotCoordinator extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    return this.serialize(() => commitBallot(this.env, input));
  }
}
