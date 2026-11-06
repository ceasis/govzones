/**
 * Anonymous ballot-level trust & safety. Operates only on ballot evidence;
 * there is no account data in this worker to consult, by construction.
 * Exposed to the admin console via the `BallotModeration` RPC entrypoint.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { nowIso } from "../../shared/http";
import { SCORING } from "../../shared/scoring";
import type { AggregateEvent, Env } from "./env";

export const RISK_REASON_CODES = [
  "BURST_ON_ENTITY",
  "COORDINATED_TIMING",
  "UNIFORM_SCORE_CAMPAIGN",
  "REPEATED_CHANGE_ATTEMPTS",
  "STAFF_REVIEW",
] as const;
export type RiskReason = (typeof RISK_REASON_CODES)[number];

export interface Actor {
  role: string;
  ref: string;
}

async function enqueue(env: Env, country: string, entityIds: Iterable<string>, reason: AggregateEvent["reason"]) {
  const messages = [...new Set(entityIds)].map((entityId) => ({
    body: { eventId: crypto.randomUUID(), country, entityId, reason } satisfies AggregateEvent,
  }));
  for (let i = 0; i < messages.length; i += 100) await env.AGGREGATE_QUEUE.sendBatch(messages.slice(i, i + 100));
}

/**
 * Quarantines ballots (PROVISIONAL or COUNTED) under one case each.
 * Requires at least two corroborating reason codes unless opened by staff:
 * a low score or criticism alone must never trigger exclusion.
 */
export async function quarantineBallots(
  env: Env,
  ballotIds: string[],
  reasons: RiskReason[],
  actor: Actor,
  now = Date.now(),
): Promise<{ quarantined: number; caseIds: string[] }> {
  const uniqueReasons = [...new Set(reasons)];
  if (actor.role.startsWith("auto:") && uniqueReasons.length < 2) {
    throw new Error("automatic quarantine requires corroborating signals");
  }
  const db = env.VOTES_DB;
  const ts = nowIso(now);
  const caseIds: string[] = [];
  const entities = new Set<string>();
  let quarantined = 0;
  for (const ballotId of ballotIds) {
    const row = await db
      .prepare(`SELECT entity_id, status, country_code FROM anonymous_ballots WHERE id = ?1`)
      .bind(ballotId)
      .first<{ entity_id: string; status: string; country_code: string }>();
    if (!row || !["PROVISIONAL", "COUNTED"].includes(row.status)) continue;
    const caseId = `BC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const results = await db.batch([
      db
        .prepare(
          `UPDATE anonymous_ballots SET status = 'QUARANTINED', updated_at = ?1, revision = revision + 1
             WHERE id = ?2 AND status IN ('PROVISIONAL', 'COUNTED')`,
        )
        .bind(ts, ballotId),
      db
        .prepare(
          `INSERT INTO ballot_risk_cases (case_id, ballot_id, entity_id, reason_codes, state, opened_by, created_at)
             SELECT ?1, ?2, ?3, ?4, 'OPEN', ?5, ?6 WHERE changes() = 1`,
        )
        .bind(caseId, ballotId, row.entity_id, JSON.stringify(uniqueReasons), actor.role, ts),
      db
        .prepare(
          `INSERT INTO moderation_audit (id, case_id, action, from_status, to_status, actor_role, actor_ref, created_at, note)
             VALUES (?1, ?2, 'QUARANTINE', ?3, 'QUARANTINED', ?4, ?5, ?6, ?7)`,
        )
        .bind(crypto.randomUUID(), caseId, row.status, actor.role, actor.ref, ts, uniqueReasons.join(",")),
    ]);
    if (results[0].meta.changes === 1) {
      quarantined++;
      caseIds.push(caseId);
      entities.add(row.entity_id);
    }
  }
  const country = env.COUNTRY_CODE;
  if (entities.size) await enqueue(env, country, entities, "moderation");
  return { quarantined, caseIds };
}

/**
 * Resolves a case. CLEAR restores exactly that one ballot's eligibility
 * (COUNTED only if its proof group and maturation allow; otherwise PROVISIONAL).
 */
export async function resolveCase(
  env: Env,
  caseId: string,
  decision: "CLEAR" | "EXCLUDE",
  note: string,
  actor: Actor,
  now = Date.now(),
): Promise<{ ok: boolean; toStatus?: string }> {
  const db = env.VOTES_DB;
  const c = await db
    .prepare(
      `SELECT c.case_id, c.ballot_id, c.entity_id, c.state, b.status, b.trust_group, b.root_anonymity_ok, b.held_since
         FROM ballot_risk_cases c JOIN anonymous_ballots b ON b.id = c.ballot_id WHERE c.case_id = ?1`,
    )
    .bind(caseId)
    .first<{
      case_id: string;
      ballot_id: string;
      entity_id: string;
      state: string;
      status: string;
      trust_group: string;
      root_anonymity_ok: number;
      held_since: string;
    }>();
  if (!c || !["OPEN", "APPEALED", "EXCLUDED"].includes(c.state)) return { ok: false };
  if (c.status === "DELETED") return { ok: false };
  const ts = nowIso(now);
  let toStatus: string;
  if (decision === "EXCLUDE") {
    toStatus = "EXCLUDED";
  } else {
    const matured = now - Date.parse(c.held_since) >= SCORING.maturationHours * 3_600_000;
    toStatus = c.trust_group === "countable" && c.root_anonymity_ok === 1 && matured ? "COUNTED" : "PROVISIONAL";
  }
  const results = await db.batch([
    db
      .prepare(
        `UPDATE anonymous_ballots SET status = ?1, updated_at = ?2, revision = revision + 1
           WHERE id = ?3 AND status IN ('QUARANTINED', 'EXCLUDED')`,
      )
      .bind(toStatus, ts, c.ballot_id),
    db
      .prepare(
        `UPDATE ballot_risk_cases SET state = ?1, reviewed_at = ?2, reviewer_ref = ?3, resolution_note = ?4 WHERE case_id = ?5`,
      )
      .bind(decision === "CLEAR" ? "CLEARED" : "EXCLUDED", ts, actor.ref, note.slice(0, 500), caseId),
    db
      .prepare(
        `INSERT INTO moderation_audit (id, case_id, action, from_status, to_status, actor_role, actor_ref, created_at, note)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(crypto.randomUUID(), caseId, decision, c.status, toStatus, actor.role, actor.ref, ts, note.slice(0, 500)),
  ]);
  if (results[0].meta.changes !== 1) return { ok: false };
  await enqueue(env, env.COUNTRY_CODE, [c.entity_id], "moderation");
  return { ok: true, toStatus };
}

/** Aggregate-only figures for the public transparency report. */
export async function transparencyFigures(env: Env) {
  const db = env.VOTES_DB;
  const byStatus = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM anonymous_ballots GROUP BY status`)
    .all<{ status: string; n: number }>();
  const cases = await db
    .prepare(`SELECT state, COUNT(*) AS n FROM ballot_risk_cases GROUP BY state`)
    .all<{ state: string; n: number }>();
  const appeals = await db.prepare(`SELECT COUNT(*) AS n FROM ballot_appeals`).first<{ n: number }>();
  const reversals = await db
    .prepare(`SELECT COUNT(*) AS n FROM moderation_audit WHERE action = 'CLEAR'`)
    .first<{ n: number }>();
  const status = Object.fromEntries(byStatus.results.map((r) => [r.status, r.n]));
  return {
    submittedActive:
      (status.PROVISIONAL ?? 0) + (status.COUNTED ?? 0) + (status.QUARANTINED ?? 0) + (status.EXCLUDED ?? 0),
    counted: status.COUNTED ?? 0,
    pendingScreening: status.PROVISIONAL ?? 0,
    withheld: (status.QUARANTINED ?? 0) + (status.EXCLUDED ?? 0),
    deleted: status.DELETED ?? 0,
    cases: Object.fromEntries(cases.results.map((r) => [r.state, r.n])),
    appeals: appeals?.n ?? 0,
    reversals: reversals?.n ?? 0,
  };
}

export class BallotModeration extends WorkerEntrypoint<Env> {
  async listCases(state: string | null, limit = 50) {
    const { results } = await this.env.VOTES_DB.prepare(
      `SELECT c.case_id, c.entity_id, c.reason_codes, c.state, c.opened_by, c.created_at, c.reviewed_at,
              c.resolution_note, b.status AS ballot_status, b.score, b.trust_group
         FROM ballot_risk_cases c JOIN anonymous_ballots b ON b.id = c.ballot_id
         WHERE (?1 IS NULL OR c.state = ?1)
         ORDER BY c.created_at DESC LIMIT ?2`,
    )
      .bind(state, Math.min(200, Math.max(1, limit)))
      .all();
    return results;
  }

  /** Recent ballots for one entity (ballot-level fields only; no nullifiers exposed). */
  async entityBallots(entityId: string, limit = 100) {
    const { results } = await this.env.VOTES_DB.prepare(
      `SELECT id, score, status, trust_group, root_anonymity_ok, held_since, updated_at, revision
         FROM anonymous_ballots WHERE entity_id = ?1 AND status != 'DELETED'
         ORDER BY updated_at DESC LIMIT ?2`,
    )
      .bind(entityId, Math.min(500, Math.max(1, limit)))
      .all();
    return results;
  }

  async quarantine(ballotIds: string[], reasons: RiskReason[], actor: Actor) {
    const valid = reasons.filter((r) => (RISK_REASON_CODES as readonly string[]).includes(r));
    return quarantineBallots(this.env, ballotIds.slice(0, 200), valid.length ? valid : ["STAFF_REVIEW"], actor);
  }

  async resolve(caseId: string, decision: "CLEAR" | "EXCLUDE", note: string, actor: Actor) {
    return resolveCase(this.env, caseId, decision, note, actor);
  }

  async transparency() {
    return transparencyFigures(this.env);
  }

  async audit(limit = 100) {
    const { results } = await this.env.VOTES_DB.prepare(
      `SELECT * FROM moderation_audit ORDER BY created_at DESC LIMIT ?1`,
    )
      .bind(Math.min(500, limit))
      .all();
    return results;
  }
}
