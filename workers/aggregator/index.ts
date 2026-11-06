/**
 * GovZones aggregate consumer.
 *
 * - Queue consumer: re-derives per-entity totals from canonical COUNTED rows
 *   (never increments), so duplicate/out-of-order deliveries are harmless.
 * - Cron: stage-2 anonymous ballot screening, 24h maturation, ranking snapshots.
 *
 * Reads/writes the votes DB and writes derived public aggregates to the
 * directory DB and KV. Holds no identity bindings.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  METHODOLOGY_VERSION,
  PERIODS,
  SCORING,
  bayesianScore,
  cohortMeanOf,
  emptyHistogram,
  lowestFirst,
  rankRows,
  type Period,
  type RankedRow,
} from "../../shared/scoring";
import { ENTITY_TYPES, type EntityType } from "../../shared/directory";
import { nowIso } from "../../shared/http";
import type { AggregateEvent } from "../ballot/env";

export interface Env {
  VOTES_DB: D1Database;
  DIRECTORY: D1Database;
  PUBLIC_CACHE: KVNamespace;
  COUNTRY_CODE: string;
  /** Local development only: enables time-travel helpers used by the e2e script. */
  DEV_TOOLS?: string;
  RISK_BURST_MIN?: string;
  RISK_BURST_BASELINE_MULTIPLIER?: string;
  RISK_UNIFORM_SHARE?: string;
  RISK_TIMING_SHARE?: string;
}

/* ------------------------------------------------------------------ */
/* Canonical recomputation                                             */
/* ------------------------------------------------------------------ */

export async function recomputeEntity(env: Env, country: string, entityId: string, now = Date.now()) {
  const cutoff12m = nowIso(now - SCORING.windowDays * 86_400_000);
  const rows = await env.VOTES_DB.prepare(
    `SELECT score,
            COUNT(*) AS n_all,
            SUM(CASE WHEN last_scored_at >= ?3 THEN 1 ELSE 0 END) AS n_12m
       FROM anonymous_ballots
      WHERE country_code = ?1 AND entity_id = ?2 AND status = 'COUNTED' AND score IS NOT NULL
      GROUP BY score`,
  )
    .bind(country, entityId, cutoff12m)
    .all<{ score: number; n_all: number; n_12m: number }>();

  const hist = { all: emptyHistogram(), "12m": emptyHistogram() } as Record<Period, number[]>;
  for (const r of rows.results) {
    hist.all[r.score - 1] = r.n_all;
    hist["12m"][r.score - 1] = r.n_12m;
  }
  const totals = (h: number[]) => ({
    count: h.reduce((a, b) => a + b, 0),
    sum: h.reduce((a, b, i) => a + b * (i + 1), 0),
  });
  const computedAt = nowIso(now);
  const stmts: D1PreparedStatement[] = [];
  for (const period of PERIODS) {
    const t = totals(hist[period]);
    stmts.push(
      env.VOTES_DB.prepare(
        `INSERT INTO aggregate_metrics (entity_id, period, counted_count, score_sum, raw_mean, histogram, source_version, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT (period, entity_id) DO UPDATE SET
             counted_count = excluded.counted_count, score_sum = excluded.score_sum, raw_mean = excluded.raw_mean,
             histogram = excluded.histogram, source_version = excluded.source_version, updated_at = excluded.updated_at
           WHERE excluded.updated_at >= aggregate_metrics.updated_at`,
      ).bind(
        entityId,
        period,
        t.count,
        t.sum,
        t.count ? t.sum / t.count : null,
        JSON.stringify(hist[period]),
        METHODOLOGY_VERSION,
        computedAt,
      ),
    );
  }
  await env.VOTES_DB.batch(stmts);

  const all = totals(hist.all);
  const y = totals(hist["12m"]);
  // Guarded write: an older computation finishing late can never roll a newer one back.
  await env.DIRECTORY.prepare(
    `INSERT INTO entity_public_stats
       (entity_id, country_code, counted_all, sum_all, counted_12m, sum_12m, histogram_all, histogram_12m, computed_at, methodology_version)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT (entity_id) DO UPDATE SET
       counted_all = excluded.counted_all, sum_all = excluded.sum_all,
       counted_12m = excluded.counted_12m, sum_12m = excluded.sum_12m,
       histogram_all = excluded.histogram_all, histogram_12m = excluded.histogram_12m,
       computed_at = excluded.computed_at, methodology_version = excluded.methodology_version
     WHERE excluded.computed_at >= entity_public_stats.computed_at`,
  )
    .bind(
      entityId,
      country,
      all.count,
      all.sum,
      y.count,
      y.sum,
      JSON.stringify(hist.all),
      JSON.stringify(hist["12m"]),
      computedAt,
      METHODOLOGY_VERSION,
    )
    .run();
  return { all, "12m": y };
}

/* ------------------------------------------------------------------ */
/* Stage-2 anonymous ballot screening (ballot-level evidence only)     */
/* ------------------------------------------------------------------ */

interface ScreenResult {
  entitiesScreened: number;
  quarantined: number;
}

/**
 * Looks only at ballot fields within the 24h hold window. A low score never triggers
 * anything on its own: quarantine requires at least two corroborating signals, and
 * quarantine only withholds the ballots pending human review.
 */
export async function screenProvisional(env: Env, now = Date.now()): Promise<ScreenResult> {
  const db = env.VOTES_DB;
  const windowStart = nowIso(now - SCORING.maturationHours * 3_600_000);
  const burstMin = Number(env.RISK_BURST_MIN ?? 25);
  const multiplier = Number(env.RISK_BURST_BASELINE_MULTIPLIER ?? 10);
  const uniformShare = Number(env.RISK_UNIFORM_SHARE ?? 0.85);
  const timingShare = Number(env.RISK_TIMING_SHARE ?? 0.5);

  const candidates = await db
    .prepare(
      `SELECT entity_id, country_code, COUNT(*) AS n FROM anonymous_ballots
        WHERE status = 'PROVISIONAL' AND held_since >= ?1
        GROUP BY entity_id, country_code HAVING COUNT(*) >= ?2`,
    )
    .bind(windowStart, burstMin)
    .all<{ entity_id: string; country_code: string; n: number }>();

  let quarantined = 0;
  for (const c of candidates.results) {
    const baseline = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM anonymous_ballots
          WHERE entity_id = ?1 AND status = 'COUNTED' AND last_scored_at >= ?2`,
      )
      .bind(c.entity_id, nowIso(now - 30 * 86_400_000))
      .first<{ n: number }>();
    const dailyBaseline = (baseline?.n ?? 0) / 30;
    const signals = new Set<string>();
    if (c.n >= Math.max(burstMin, multiplier * dailyBaseline)) signals.add("BURST_ON_ENTITY");

    const scores = await db
      .prepare(
        `SELECT score, COUNT(*) AS n FROM anonymous_ballots
          WHERE entity_id = ?1 AND status = 'PROVISIONAL' AND held_since >= ?2 GROUP BY score ORDER BY n DESC`,
      )
      .bind(c.entity_id, windowStart)
      .all<{ score: number; n: number }>();
    const dominant = scores.results[0];
    if (dominant && dominant.n / c.n >= uniformShare) signals.add("UNIFORM_SCORE_CAMPAIGN");

    const timing = await db
      .prepare(
        `SELECT substr(held_since, 1, 15) AS bucket, COUNT(*) AS n FROM anonymous_ballots
          WHERE entity_id = ?1 AND status = 'PROVISIONAL' AND held_since >= ?2
          GROUP BY bucket ORDER BY n DESC LIMIT 1`,
      )
      .bind(c.entity_id, windowStart)
      .first<{ bucket: string; n: number }>();
    // substr(…,1,15) = "YYYY-MM-DDTHH:M" → 10-minute buckets
    if (timing && timing.n / c.n >= timingShare) signals.add("COORDINATED_TIMING");

    if (signals.size < 2 || !dominant) continue;
    const reasons = JSON.stringify([...signals]);
    const ballots = await db
      .prepare(
        `SELECT id FROM anonymous_ballots
          WHERE entity_id = ?1 AND status = 'PROVISIONAL' AND held_since >= ?2 AND score = ?3`,
      )
      .bind(c.entity_id, windowStart, dominant.score)
      .all<{ id: string }>();
    const ts = nowIso(now);
    for (const b of ballots.results) {
      const caseId = `BC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const res = await db.batch([
        db
          .prepare(
            `UPDATE anonymous_ballots SET status = 'QUARANTINED', updated_at = ?1, revision = revision + 1
              WHERE id = ?2 AND status = 'PROVISIONAL'`,
          )
          .bind(ts, b.id),
        db
          .prepare(
            `INSERT INTO ballot_risk_cases (case_id, ballot_id, entity_id, reason_codes, state, opened_by, created_at)
               SELECT ?1, ?2, ?3, ?4, 'OPEN', 'auto:stage2', ?5 WHERE changes() = 1`,
          )
          .bind(caseId, b.id, c.entity_id, reasons, ts),
      ]);
      if (res[0].meta.changes === 1) quarantined++;
    }
  }
  return { entitiesScreened: candidates.results.length, quarantined };
}

/** PROVISIONAL → COUNTED after the hold, only for countable proofs from anonymity-OK roots. */
export async function matureBallots(env: Env, now = Date.now()): Promise<string[]> {
  const cutoff = nowIso(now - SCORING.maturationHours * 3_600_000);
  const res = await env.VOTES_DB.prepare(
    `UPDATE anonymous_ballots SET status = 'COUNTED', updated_at = ?1, revision = revision + 1
      WHERE status = 'PROVISIONAL' AND trust_group = 'countable' AND root_anonymity_ok = 1 AND held_since <= ?2
        AND NOT EXISTS (
          SELECT 1 FROM ballot_risk_cases c
           WHERE c.ballot_id = anonymous_ballots.id AND c.state IN ('OPEN', 'APPEALED', 'EXCLUDED'))
      RETURNING entity_id`,
  )
    .bind(nowIso(now), cutoff)
    .all<{ entity_id: string }>();
  return [...new Set(res.results.map((r) => r.entity_id))];
}

/* ------------------------------------------------------------------ */
/* Ranking snapshots                                                   */
/* ------------------------------------------------------------------ */

interface StatsRow {
  entity_id: string;
  name: string;
  slug: string;
  type: EntityType;
  acronym: string | null;
  region_id: string | null;
  province_id: string | null;
  city_id: string | null;
  place: string | null;
  region_name: string | null;
  counted_12m: number;
  sum_12m: number;
  counted_all: number;
  sum_all: number;
}

export interface SnapshotRow extends RankedRow {
  slug: string;
  type: EntityType;
  acronym: string | null;
  regionId: string | null;
  provinceId: string | null;
  cityId: string | null;
  place: string;
}

export interface RankingSnapshot {
  country: string;
  cohort: EntityType | "mixed";
  period: Period;
  best: SnapshotRow[];
  lowest: SnapshotRow[];
  mostRated: Array<Omit<SnapshotRow, "rank" | "adjustedScore"> & { rank: number; qualified: boolean }>;
  cohortMean: number | null;
  cohortRatings: number;
  cohortEntitiesRated: number;
  minVotes: number;
  priorStrength: number;
  methodologyVersion: string;
  generatedAt: string;
}

export async function buildRankings(env: Env, country: string, now = Date.now()) {
  const { results } = await env.DIRECTORY.prepare(
    `SELECT s.entity_id, e.name, e.slug, e.type, e.acronym, e.region_id, e.province_id, e.city_id,
            COALESCE(g.name, 'Nationwide') AS place, r.short_name AS region_name,
            s.counted_12m, s.sum_12m, s.counted_all, s.sum_all
       FROM entity_public_stats s
       JOIN entities e ON e.id = s.entity_id
       LEFT JOIN geo_units g ON g.id = e.geo_unit_id
       LEFT JOIN geo_units r ON r.id = e.region_id
      WHERE s.country_code = ?1 AND e.status = 'ACTIVE' AND (s.counted_all > 0)`,
  )
    .bind(country)
    .all<StatsRow>();

  const generatedAt = nowIso(now);
  const written: string[] = [];
  for (const period of PERIODS) {
    const agg = (r: StatsRow) =>
      period === "12m" ? { count: r.counted_12m, sum: r.sum_12m } : { count: r.counted_all, sum: r.sum_all };
    const cohortMeans = new Map<EntityType, number | null>();
    for (const type of ENTITY_TYPES) {
      cohortMeans.set(type, cohortMeanOf(results.filter((r) => r.type === type).map(agg)));
    }
    const decorate = (r: StatsRow) => ({
      entityId: r.entity_id,
      name: r.name,
      slug: r.slug,
      type: r.type,
      acronym: r.acronym,
      regionId: r.region_id,
      provinceId: r.province_id,
      cityId: r.city_id,
      place: r.place && r.region_name && r.place !== r.region_name ? `${r.place}, ${r.region_name}` : r.place ?? "Nationwide",
      ...agg(r),
    });

    const cohorts: Array<EntityType | "mixed"> = [...ENTITY_TYPES, "mixed"];
    for (const cohort of cohorts) {
      const members = results.filter((r) => (cohort === "mixed" || r.type === cohort) && agg(r).count > 0);
      const decorated = members.map(decorate);
      let best: SnapshotRow[];
      if (cohort === "mixed") {
        // Mixed view: each entity is adjusted toward its OWN type's cohort mean, then sorted together.
        const ranked = decorated
          .filter((d) => d.count >= SCORING.minRankingVotes)
          .map((d) => ({
            ...d,
            rawMean: d.sum / d.count,
            adjustedScore: bayesianScore(d, cohortMeans.get(d.type) ?? d.sum / d.count),
            rank: 0,
          }));
        ranked.sort((a, b) => b.adjustedScore - a.adjustedScore || b.count - a.count || a.name.localeCompare(b.name));
        ranked.forEach((r, i) => (r.rank = i + 1));
        best = ranked;
      } else {
        const mean = cohortMeans.get(cohort) ?? null;
        best = mean === null ? [] : (rankRows(decorated, mean) as SnapshotRow[]);
      }
      const cohortRows = members.map(agg);
      const snapshot: RankingSnapshot = {
        country,
        cohort,
        period,
        best,
        lowest: lowestFirst(best) as SnapshotRow[],
        mostRated: [...decorated]
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
          .slice(0, 100)
          .map((d, i) => ({ ...d, rawMean: d.sum / d.count, rank: i + 1, qualified: d.count >= SCORING.minRankingVotes })),
        cohortMean: cohort === "mixed" ? cohortMeanOf(cohortRows) : (cohortMeans.get(cohort) ?? null),
        cohortRatings: cohortRows.reduce((a, r) => a + r.count, 0),
        cohortEntitiesRated: cohortRows.length,
        minVotes: SCORING.minRankingVotes,
        priorStrength: SCORING.priorStrength,
        methodologyVersion: METHODOLOGY_VERSION,
        generatedAt,
      };
      const key = `rankings:${country}:${cohort}:${period}`;
      await env.PUBLIC_CACHE.put(key, JSON.stringify(snapshot));
      written.push(key);
    }
  }
  await env.PUBLIC_CACHE.put(`rankings-meta:${country}`, JSON.stringify({ generatedAt }));
  return written;
}

async function publishTransparency(env: Env, country: string, now = Date.now()) {
  const db = env.VOTES_DB;
  const byStatus = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM anonymous_ballots WHERE country_code = ?1 GROUP BY status`)
    .bind(country)
    .all<{ status: string; n: number }>();
  const s = Object.fromEntries(byStatus.results.map((r) => [r.status, r.n])) as Record<string, number>;
  const appeals = await db.prepare(`SELECT COUNT(*) AS n FROM ballot_appeals`).first<{ n: number }>();
  const reversals = await db
    .prepare(`SELECT COUNT(*) AS n FROM moderation_audit WHERE action = 'CLEAR'`)
    .first<{ n: number }>();
  const exclusions = await db
    .prepare(`SELECT COUNT(*) AS n FROM moderation_audit WHERE action = 'EXCLUDE'`)
    .first<{ n: number }>();
  const report = {
    country,
    policyVersion: METHODOLOGY_VERSION,
    generatedAt: nowIso(now),
    activeSubmissions: (s.PROVISIONAL ?? 0) + (s.COUNTED ?? 0) + (s.QUARANTINED ?? 0) + (s.EXCLUDED ?? 0),
    counted: s.COUNTED ?? 0,
    pendingOrNotCounted: s.PROVISIONAL ?? 0,
    withheldForReview: s.QUARANTINED ?? 0,
    excluded: s.EXCLUDED ?? 0,
    appealsReceived: appeals?.n ?? 0,
    exclusionsConfirmed: exclusions?.n ?? 0,
    reversals: reversals?.n ?? 0,
  };
  await env.PUBLIC_CACHE.put(`transparency:${country}`, JSON.stringify(report));
  return report;
}

async function cleanupChallenges(env: Env, now = Date.now()) {
  await env.VOTES_DB.prepare(
    `DELETE FROM proof_challenges WHERE rowid IN
       (SELECT rowid FROM proof_challenges WHERE expires_at < ?1 LIMIT 1000)`,
  )
    .bind(nowIso(now - 3_600_000))
    .run();
}

export async function tick(env: Env, opts: { forceRankings?: boolean } = {}, now = Date.now()) {
  const country = env.COUNTRY_CODE;
  const screen = await screenProvisional(env, now);
  const matured = await matureBallots(env, now);
  for (const entityId of matured) await recomputeEntity(env, country, entityId, now);
  // Quarantines from screening may have touched previously counted ballots in other flows;
  // their recomputation arrives via the queue.
  const minute = new Date(now).getUTCMinutes();
  let rankings: string[] = [];
  if (opts.forceRankings || minute % 5 === 0 || matured.length > 0) {
    rankings = await buildRankings(env, country, now);
    await publishTransparency(env, country, now);
  }
  await cleanupChallenges(env, now);
  return { screen, matured: matured.length, rankingsWritten: rankings.length };
}

/** Rebuild every entity aggregate from canonical rows (disaster recovery / methodology change). */
export async function rebuildAll(env: Env, now = Date.now()) {
  const { results } = await env.VOTES_DB.prepare(
    `SELECT DISTINCT entity_id FROM anonymous_ballots WHERE country_code = ?1`,
  )
    .bind(env.COUNTRY_CODE)
    .all<{ entity_id: string }>();
  for (const r of results) await recomputeEntity(env, env.COUNTRY_CODE, r.entity_id, now);
  await buildRankings(env, env.COUNTRY_CODE, now);
  await publishTransparency(env, env.COUNTRY_CODE, now);
  return { entities: results.length };
}

/** Operational RPC (admin console / dev tooling). */
export class AggregatorOps extends WorkerEntrypoint<Env> {
  async tick(forceRankings = true) {
    return tick(this.env, { forceRankings });
  }
  async rebuildAll() {
    return rebuildAll(this.env);
  }

  /** DEV ONLY: shifts ballot clocks back to simulate the 24 h hold / 30-day cooldown passing. */
  async devAge(hours: number, opts: { lastScored?: boolean } = {}) {
    if (this.env.DEV_TOOLS !== "1") throw new Error("dev tools disabled");
    const shift = `-${Math.max(0, Math.min(24 * 400, Math.floor(hours)))} hours`;
    const res = await this.env.VOTES_DB.prepare(
      `UPDATE anonymous_ballots SET held_since = strftime('%Y-%m-%dT%H:%M:%fZ', held_since, ?1),
         last_scored_at = CASE WHEN ?2 = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', last_scored_at, ?1) ELSE last_scored_at END`,
    )
      .bind(shift, opts.lastScored ? 1 : 0)
      .run();
    return { shifted: res.meta.changes };
  }

  /**
   * DEV ONLY: synthetic COUNTED ballots so rankings can be previewed locally. Rows are tagged with
   * root_epoch = -1 and random fake nullifiers; `devClearDemo` removes them. Never enabled in deployments.
   */
  async devSeedDemo(entities = 14) {
    if (this.env.DEV_TOOLS !== "1") throw new Error("dev tools disabled");
    const { results } = await this.env.DIRECTORY.prepare(
      `SELECT id, type FROM entities WHERE country_code = ?1 AND status = 'ACTIVE' AND type IN ('AGENCY', 'OTHER_PUBLIC_BODY', 'LGU', 'FIELD_OFFICE')
        ORDER BY type = 'AGENCY' DESC, name LIMIT ?2`,
    )
      .bind(this.env.COUNTRY_CODE, Math.min(60, entities * 2))
      .all<{ id: string; type: string }>();
    const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    let inserted = 0;
    for (const e of results) {
      const n = 12 + Math.floor(rand() * 80);
      const center = 2 + rand() * 7;
      const stmts: D1PreparedStatement[] = [];
      for (let i = 0; i < n; i++) {
        const score = Math.max(1, Math.min(10, Math.round(center + (rand() - 0.5) * 5)));
        const at = new Date(Date.now() - (2 + rand() * 330) * 86_400_000).toISOString();
        const nullifier = [...crypto.getRandomValues(new Uint8Array(30))].map((b) => (b % 10).toString()).join("");
        stmts.push(
          this.env.VOTES_DB.prepare(
            `INSERT INTO anonymous_ballots (id, country_code, entity_id, scoped_nullifier, score, status, trust_group, root_epoch,
               root_anonymity_ok, held_since, last_scored_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'COUNTED', 'countable', -1, 1, ?6, ?6, ?6, ?6)`,
          ).bind(crypto.randomUUID(), this.env.COUNTRY_CODE, e.id, nullifier, score, at),
        );
      }
      await this.env.VOTES_DB.batch(stmts);
      inserted += n;
    }
    return { entities: results.length, inserted, rebuilt: await rebuildAll(this.env) };
  }

  async devClearDemo() {
    if (this.env.DEV_TOOLS !== "1") throw new Error("dev tools disabled");
    const res = await this.env.VOTES_DB.prepare(`DELETE FROM anonymous_ballots WHERE root_epoch = -1`).run();
    return { deleted: res.meta.changes, rebuilt: await rebuildAll(this.env) };
  }

  /** DEV ONLY: raw ballot rows for one entity (used by the e2e uniqueness checks). */
  async devEntityBallots(entityId: string) {
    if (this.env.DEV_TOOLS !== "1") throw new Error("dev tools disabled");
    const { results } = await this.env.VOTES_DB.prepare(
      `SELECT id, score, status, trust_group, root_anonymity_ok, scoped_nullifier, revision FROM anonymous_ballots WHERE entity_id = ?1`,
    )
      .bind(entityId)
      .all();
    return results;
  }
}

export default {
  async queue(batch: MessageBatch<AggregateEvent>, env: Env) {
    const now = Date.now();
    const seen = new Set<string>();
    for (const msg of batch.messages) {
      const e = msg.body;
      const key = `${e.country}:${e.entityId}`;
      if (!seen.has(key)) {
        seen.add(key);
        await recomputeEntity(env, e.country, e.entityId, now);
      }
      await env.VOTES_DB.prepare(
        `INSERT INTO aggregate_jobs (event_id, entity_id, processed_at, result_version) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (event_id) DO NOTHING`,
      )
        .bind(e.eventId, e.entityId, nowIso(now), METHODOLOGY_VERSION)
        .run();
      msg.ack();
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(tick(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env, AggregateEvent>;
