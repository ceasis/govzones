import { describe, expect, it, beforeEach } from "vitest";
import { FakeD1, FakeKV, FakeQueue } from "./helpers/d1";
import { commitBallot, type CommitInput } from "../workers/ballot/coordinator";
import { quarantineBallots, resolveCase } from "../workers/ballot/moderation";
import { buildRankings, matureBallots, recomputeEntity, screenProvisional } from "../workers/aggregator/index";
import { sha256Hex } from "../shared/signing";

const E1 = "11111111-1111-4111-8111-111111111111";
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");

let votes: FakeD1;
let directory: FakeD1;
let kv: FakeKV;
let queue: FakeQueue<unknown>;
const ballotEnv = () => ({ VOTES_DB: votes, AGGREGATE_QUEUE: queue, COUNTRY_CODE: "PH", COOLDOWN_DAYS: "30" }) as never;
const aggEnv = () => ({ VOTES_DB: votes, DIRECTORY: directory, PUBLIC_CACHE: kv, COUNTRY_CODE: "PH" }) as never;

let challengeN = 0;
async function challenge(op: "UPSERT" | "DELETE" | "APPEAL" = "UPSERT", entity = E1, now = T0, ttl = 300_000) {
  const raw = `challenge-${challengeN++}-${"x".repeat(20)}`;
  const hash = await sha256Hex(raw);
  await votes
    .prepare(`INSERT INTO proof_challenges (challenge_hash, entity_id, operation, issued_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(hash, entity, op, new Date(now).toISOString(), new Date(now + ttl).toISOString())
    .run();
  return hash;
}

async function commit(nullifier: string, score: number | null, now: number, extra: Partial<CommitInput> = {}) {
  const op = extra.operation ?? "UPSERT";
  return commitBallot(
    ballotEnv(),
    {
      country: "PH",
      entityId: E1,
      operation: op,
      score,
      nullifier,
      challengeHash: await challenge(op, extra.entityId ?? E1, now),
      trustGroup: "countable",
      rootEpoch: 1,
      rootAnonymityOk: true,
      ...extra,
    },
    now,
  );
}

const rows = async () => (await votes.prepare(`SELECT * FROM anonymous_ballots ORDER BY created_at`).all<Record<string, unknown>>()).results;

beforeEach(() => {
  votes = new FakeD1("votes");
  directory = new FakeD1("directory");
  kv = new FakeKV();
  queue = new FakeQueue();
  directory.exec(
    `INSERT INTO entities (id, country_code, type, name, normalized_name, slug, created_at, updated_at) VALUES ('${E1}', 'PH', 'AGENCY', 'Test Agency', 'test agency', 'test-agency', 'x', 'x')`,
  );
});

describe("canonical ballot writes", () => {
  it("one-time challenges: replay, expiry and operation binding", async () => {
    const h = await challenge("UPSERT", E1, T0);
    const input = { country: "PH", entityId: E1, operation: "UPSERT" as const, score: 5, nullifier: "1", challengeHash: h, trustGroup: "countable" as const, rootEpoch: 1, rootAnonymityOk: true };
    expect((await commitBallot(ballotEnv(), input, T0)).ok).toBe(true);
    expect(await commitBallot(ballotEnv(), input, T0)).toMatchObject({ ok: false, code: "REPLAYED_CHALLENGE" });
    const expired = await challenge("UPSERT", E1, T0 - 600_000);
    expect(await commitBallot(ballotEnv(), { ...input, nullifier: "2", challengeHash: expired }, T0)).toMatchObject({ ok: false, code: "EXPIRED_CHALLENGE" });
    const del = await challenge("DELETE", E1, T0);
    expect(await commitBallot(ballotEnv(), { ...input, nullifier: "3", challengeHash: del }, T0)).toMatchObject({ ok: false, code: "EXPIRED_CHALLENGE" });
  });

  it("creates PROVISIONAL, never more than one row per (entity, nullifier)", async () => {
    const results = await Promise.all([commit("42", 7, T0), commit("42", 8, T0), commit("42", 7, T0)]);
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("PROVISIONAL");
  });

  it("enforces the 30-day cooldown for score changes and returns the next editable date", async () => {
    await commit("42", 7, T0);
    const r = await commit("42", 3, T0 + 10 * DAY);
    expect(r).toMatchObject({ ok: false, code: "VOTE_COOLDOWN" });
    expect((r as { nextEditableAt: string }).nextEditableAt).toBe(new Date(T0 + 30 * DAY).toISOString());
    const later = await commit("42", 3, T0 + 31 * DAY);
    expect(later.ok).toBe(true);
    const [row] = await rows();
    expect(row.score).toBe(3);
    expect(row.revision).toBe(2);
  });

  it("allows a same-score trust upgrade (submit → countable) during cooldown without adding a vote", async () => {
    await commit("42", 6, T0, { trustGroup: "submit" });
    const up = await commit("42", 6, T0 + DAY, { trustGroup: "countable" });
    expect(up.ok).toBe(true);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].trust_group).toBe("countable");
    expect(all[0].last_scored_at).toBe(new Date(T0).toISOString());
  });

  it("delete is wallet-authorized and cannot be used to bypass the cooldown", async () => {
    await commit("42", 6, T0);
    expect(await commit("42", null, T0 + DAY, { operation: "DELETE" })).toMatchObject({ ok: true, status: "deleted" });
    const [row] = await rows();
    expect(row.status).toBe("DELETED");
    expect(row.score).toBeNull();
    expect(await commit("42", 9, T0 + 2 * DAY)).toMatchObject({ ok: false, code: "VOTE_COOLDOWN" });
  });

  it("an update never launders a quarantined ballot back into the count", async () => {
    await commit("42", 2, T0);
    const [b] = await rows();
    await quarantineBallots(ballotEnv(), [b.id as string], ["STAFF_REVIEW"], { role: "moderator", ref: "t" }, T0 + DAY);
    await commit("42", 3, T0 + 31 * DAY);
    const [after] = await rows();
    expect(after.status).toBe("QUARANTINED");
    expect(after.score).toBe(3);
  });
});

describe("two-stage troll filtering and counting", () => {
  async function seedCounted(n: number, score: number, opts: { group?: "submit" | "countable"; anon?: boolean } = {}) {
    for (let i = 0; i < n; i++) await commit(`${score}-${i}-${opts.group ?? "c"}`, score, T0, { trustGroup: opts.group ?? "countable", rootAnonymityOk: opts.anon ?? true });
  }

  it("matures only countable, anonymity-OK ballots after 24 h (AC-15, AC-20)", async () => {
    await seedCounted(3, 8);
    await seedCounted(2, 1, { group: "submit" });
    await seedCounted(2, 5, { anon: false });
    expect(await matureBallots(aggEnv(), T0 + 23 * 3_600_000)).toEqual([]);
    expect(await matureBallots(aggEnv(), T0 + 25 * 3_600_000)).toEqual([E1]);
    const stats = await recomputeEntity(aggEnv(), "PH", E1, T0 + 25 * 3_600_000);
    expect(stats["12m"]).toEqual({ count: 3, sum: 24 });
  });

  it("recomputation is idempotent and never rolls back on out-of-order delivery (AC-08)", async () => {
    await seedCounted(4, 9);
    await matureBallots(aggEnv(), T0 + 25 * 3_600_000);
    const late = T0 + 26 * 3_600_000;
    await recomputeEntity(aggEnv(), "PH", E1, late);
    await recomputeEntity(aggEnv(), "PH", E1, late); // duplicate delivery
    // A stale computation finishing after a newer one must not overwrite it.
    await votes.prepare(`UPDATE anonymous_ballots SET status = 'EXCLUDED' WHERE rowid = 1`).run();
    await recomputeEntity(aggEnv(), "PH", E1, late - 3_600_000);
    const s = await directory.prepare(`SELECT counted_all, computed_at FROM entity_public_stats WHERE entity_id = ?1`).bind(E1).first<{ counted_all: number; computed_at: string }>();
    expect(s).toMatchObject({ counted_all: 4, computed_at: new Date(late).toISOString() });
    await recomputeEntity(aggEnv(), "PH", E1, late + 1);
    const s2 = await directory.prepare(`SELECT counted_all FROM entity_public_stats WHERE entity_id = ?1`).bind(E1).first<{ counted_all: number }>();
    expect(s2?.counted_all).toBe(3);
  });

  it("quarantine removes exactly one contribution and clearing restores it (AC-16)", async () => {
    await seedCounted(5, 7);
    await matureBallots(aggEnv(), T0 + 25 * 3_600_000);
    const target = (await rows())[0].id as string;
    const { caseIds } = await quarantineBallots(ballotEnv(), [target], ["STAFF_REVIEW"], { role: "moderator", ref: "t" }, T0 + 26 * 3_600_000);
    expect((await recomputeEntity(aggEnv(), "PH", E1, T0 + 27 * 3_600_000)).all.count).toBe(4);
    expect(await resolveCase(ballotEnv(), caseIds[0], "CLEAR", "insufficient evidence", { role: "moderator", ref: "t" }, T0 + 28 * 3_600_000)).toMatchObject({ ok: true, toStatus: "COUNTED" });
    expect((await recomputeEntity(aggEnv(), "PH", E1, T0 + 29 * 3_600_000)).all.count).toBe(5);
  });

  it("low scores alone never trigger automatic quarantine", async () => {
    await seedCounted(10, 1); // uniform 1/10 but well below the burst threshold
    expect((await screenProvisional(aggEnv(), T0 + 3_600_000)).quarantined).toBe(0);
  });

  it("a burst + uniform score + coordinated timing campaign is quarantined, not counted", async () => {
    await seedCounted(30, 1);
    const r = await screenProvisional(aggEnv(), T0 + 3_600_000);
    expect(r.quarantined).toBe(30);
    expect(await matureBallots(aggEnv(), T0 + 25 * 3_600_000)).toEqual([]);
  });

  it("automatic quarantine refuses a single uncorroborated signal", async () => {
    await seedCounted(1, 4);
    await expect(quarantineBallots(ballotEnv(), [(await rows())[0].id as string], ["BURST_ON_ENTITY"], { role: "auto:test", ref: "auto" })).rejects.toThrow();
  });
});

describe("ranking snapshots", () => {
  it("lists nothing before the first eligible rating and ranks an entity from its first (AC-07, floor lowered to 1)", async () => {
    await buildRankings(aggEnv(), "PH", T0);
    expect((await kv.get("rankings:PH:AGENCY:12m", { type: "json" })).best).toHaveLength(0);
    await commit("n0", 10, T0);
    await matureBallots(aggEnv(), T0 + 25 * 3_600_000);
    await recomputeEntity(aggEnv(), "PH", E1, T0 + 25 * 3_600_000);
    await buildRankings(aggEnv(), "PH", T0 + 25 * 3_600_000);
    const snap = await kv.get("rankings:PH:AGENCY:12m", { type: "json" });
    expect(snap.minVotes).toBe(1);
    expect(snap.best).toHaveLength(1);
    expect(snap.best[0]).toMatchObject({ count: 1, rawMean: 10, rank: 1 });
    expect(snap.lowest[0]).toMatchObject({ count: 1, rank: 1 });
    expect(snap.mostRated[0]).toMatchObject({ count: 1, qualified: true });
  });
});
