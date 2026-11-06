/**
 * Public read model: directory, public aggregates and ranking snapshots.
 * Shared by SSR loaders and the /api/v1 JSON API. Only public data lives here.
 */
import {
  ENTITY_TYPES,
  QUICK_FILTERS,
  ftsQuery,
  isEntityType,
  isRankingCohort,
  normalizeText,
  type EntityType,
  type QuickFilter,
  type RankingCohort,
} from "../../shared/directory";
import { METHODOLOGY_VERSION, SCORING, publicHistogram, type HistogramCell, type Period } from "../../shared/scoring";
import type { RankingSnapshot, SnapshotRow } from "../../workers/aggregator/index";

export interface Country {
  code: string;
  name: string;
  pathSegment: string;
  status: "ACTIVE" | "PLANNED" | "DISABLED";
}

export interface GeoUnit {
  id: string;
  type: string;
  name: string;
  shortName: string | null;
  parentId: string | null;
}

export interface PublicScore {
  period: Period;
  count: number;
  mean: number | null;
  /** Average is shown only at or above SCORING.profileMinDisplay counted ratings. */
  displayable: boolean;
  qualifiesForRanking: boolean;
  histogram: HistogramCell[] | null;
  computedAt: string | null;
  methodologyVersion: string;
}

export interface EntitySummary {
  id: string;
  slug: string;
  type: EntityType;
  name: string;
  acronym: string | null;
  place: string;
  verified: boolean;
  scores: { "12m": PublicScore; all: PublicScore };
}

export interface EntityDetail extends EntitySummary {
  countryCode: string;
  description: string | null;
  officialUrl: string | null;
  address: string | null;
  status: string;
  ratable: boolean;
  verifiedAt: string | null;
  updatedAt: string;
  createdAt: string;
  parent: { id: string; name: string; slug: string; type: EntityType; acronym: string | null } | null;
  breadcrumbs: Array<{ id: string; name: string; type: string }>;
  aliases: string[];
  sources: Array<{ url: string; publisher: string; checkedAt: string | null; status: string }>;
  children: EntitySummary[];
  childCount: number;
  branchSummary: { entities: number; ratings: number; mean: number | null } | null;
  geoIds: { regionId: string | null; provinceId: string | null; cityId: string | null };
}

interface EntityRow {
  id: string;
  country_code: string;
  type: EntityType;
  parent_entity_id: string | null;
  geo_unit_id: string | null;
  region_id: string | null;
  province_id: string | null;
  city_id: string | null;
  name: string;
  acronym: string | null;
  slug: string;
  description: string | null;
  official_url: string | null;
  address: string | null;
  status: string;
  ratable: number;
  merged_into_id: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
  geo_name: string | null;
  region_short: string | null;
  province_name: string | null;
  counted_12m: number | null;
  sum_12m: number | null;
  counted_all: number | null;
  sum_all: number | null;
  histogram_12m: string | null;
  histogram_all: string | null;
  computed_at: string | null;
}

const ENTITY_COLUMNS = `e.*, g.name AS geo_name, r.short_name AS region_short, p.name AS province_name,
         s.counted_12m, s.sum_12m, s.counted_all, s.sum_all, s.histogram_12m, s.histogram_all, s.computed_at`;
const ENTITY_JOINS = `
    LEFT JOIN geo_units g ON g.id = e.geo_unit_id
    LEFT JOIN geo_units r ON r.id = e.region_id
    LEFT JOIN geo_units p ON p.id = e.province_id
    LEFT JOIN entity_public_stats s ON s.entity_id = e.id`;
const ENTITY_SELECT = `SELECT ${ENTITY_COLUMNS} FROM entities e ${ENTITY_JOINS}`;

function buildScore(period: Period, count: number, sum: number, hist: string | null, computedAt: string | null): PublicScore {
  const histogram = hist ? (JSON.parse(hist) as number[]) : null;
  return {
    period,
    count,
    mean: count > 0 ? sum / count : null,
    displayable: count >= SCORING.profileMinDisplay,
    qualifiesForRanking: count >= SCORING.minRankingVotes,
    histogram: histogram ? publicHistogram(histogram, count) : null,
    computedAt,
    methodologyVersion: METHODOLOGY_VERSION,
  };
}

function placeLabel(r: Pick<EntityRow, "geo_name" | "region_short" | "province_name" | "geo_unit_id" | "type">): string {
  if (!r.geo_unit_id) return "Nationwide";
  const parts = [r.geo_name];
  if (r.province_name && r.province_name !== r.geo_name) parts.push(r.province_name);
  else if (r.region_short && r.region_short !== r.geo_name) parts.push(r.region_short);
  return parts.filter(Boolean).join(", ");
}

function toSummary(r: EntityRow): EntitySummary {
  return {
    id: r.id,
    slug: r.slug,
    type: r.type,
    name: r.name,
    acronym: r.acronym,
    place: placeLabel(r),
    verified: Boolean(r.verified_at),
    scores: {
      "12m": buildScore("12m", r.counted_12m ?? 0, r.sum_12m ?? 0, r.histogram_12m, r.computed_at),
      all: buildScore("all", r.counted_all ?? 0, r.sum_all ?? 0, r.histogram_all, r.computed_at),
    },
  };
}

export async function listCountries(db: D1Database): Promise<Country[]> {
  const { results } = await db
    .prepare(`SELECT code, name, path_segment, status FROM countries ORDER BY status = 'ACTIVE' DESC, name`)
    .all<{ code: string; name: string; path_segment: string; status: Country["status"] }>();
  return results.map((c) => ({ code: c.code, name: c.name, pathSegment: c.path_segment, status: c.status }));
}

export async function countryBySegment(db: D1Database, segment: string): Promise<Country | null> {
  const c = await db
    .prepare(`SELECT code, name, path_segment, status FROM countries WHERE path_segment = ?1`)
    .bind(segment.toLowerCase())
    .first<{ code: string; name: string; path_segment: string; status: Country["status"] }>();
  return c ? { code: c.code, name: c.name, pathSegment: c.path_segment, status: c.status } : null;
}

export async function geoChildren(db: D1Database, country: string, parentId: string | null, type?: string): Promise<GeoUnit[]> {
  const { results } = await db
    .prepare(
      `SELECT id, type, name, short_name, parent_id FROM geo_units
        WHERE country_code = ?1 AND ((?2 IS NULL AND parent_id IS NULL) OR parent_id = ?2) AND (?3 IS NULL OR type = ?3)
        ORDER BY sort_order, name LIMIT 500`,
    )
    .bind(country, parentId, type ?? null)
    .all<{ id: string; type: string; name: string; short_name: string | null; parent_id: string | null }>();
  return results.map((g) => ({ id: g.id, type: g.type, name: g.name, shortName: g.short_name, parentId: g.parent_id }));
}

export async function geoUnit(db: D1Database, id: string): Promise<GeoUnit | null> {
  const g = await db
    .prepare(`SELECT id, type, name, short_name, parent_id FROM geo_units WHERE id = ?1`)
    .bind(id)
    .first<{ id: string; type: string; name: string; short_name: string | null; parent_id: string | null }>();
  return g ? { id: g.id, type: g.type, name: g.name, shortName: g.short_name, parentId: g.parent_id } : null;
}

export interface SearchParams {
  country: string;
  q?: string;
  types?: EntityType[];
  regionId?: string | null;
  provinceId?: string | null;
  cityId?: string | null;
  minVotes?: number;
  offset?: number;
  limit?: number;
}

export function encodeCursor(offset: number): string {
  return btoa(`o:${offset}`).replace(/=+$/, "");
}
export function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const m = atob(cursor).match(/^o:(\d{1,6})$/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Ranking: exact official name > exact alias/acronym > prefix > token/fuzzy (bm25),
 * then popularity (eligible ratings) and name as tie-breakers.
 */
export async function searchEntities(db: D1Database, p: SearchParams): Promise<{ items: EntitySummary[]; nextCursor: string | null }> {
  const limit = Math.min(50, Math.max(1, p.limit ?? 20));
  const offset = Math.max(0, p.offset ?? 0);
  const types = (p.types ?? []).filter(isEntityType);
  const typeClause = types.length ? `AND e.type IN (${types.map((t) => `'${t}'`).join(",")})` : "";
  const norm = normalizeText(p.q ?? "");
  const fts = ftsQuery(p.q ?? "");
  const filters = `
      AND e.country_code = ?1 AND e.status = 'ACTIVE' ${typeClause}
      AND (?2 IS NULL OR e.region_id = ?2) AND (?3 IS NULL OR e.province_id = ?3)
      AND (?4 IS NULL OR e.city_id = ?4 OR e.geo_unit_id = ?4)
      AND COALESCE(s.counted_12m, 0) >= ?5`;
  const binds = [p.country, p.regionId ?? null, p.provinceId ?? null, p.cityId ?? null, Math.max(0, p.minVotes ?? 0)];

  let rows: EntityRow[];
  if (fts) {
    const sql = `
      SELECT * FROM (
        SELECT ${ENTITY_COLUMNS},
               CASE
                 WHEN e.normalized_name = ?6 THEN 0
                 WHEN lower(COALESCE(e.acronym, '')) = ?6
                   OR EXISTS (SELECT 1 FROM entity_aliases a WHERE a.entity_id = e.id AND a.normalized_alias = ?6) THEN 1
                 WHEN e.normalized_name LIKE ?6 || '%'
                   OR EXISTS (SELECT 1 FROM entity_aliases a WHERE a.entity_id = e.id AND a.normalized_alias LIKE ?6 || '%') THEN 2
                 ELSE 3
               END AS tier,
               bm25(entity_search, 0.0, 10.0, 8.0, 4.0, 3.0) AS rel
          FROM entity_search JOIN entities e ON e.id = entity_search.entity_id ${ENTITY_JOINS}
          WHERE entity_search MATCH ?7 ${filters}
      )
      ORDER BY tier, rel, COALESCE(counted_12m, 0) DESC, name
      LIMIT ?8 OFFSET ?9`;
    const res = await db
      .prepare(sql)
      .bind(...binds, norm, fts, limit + 1, offset)
      .all<EntityRow>();
    rows = res.results;
    // Fuzzy fallback: when no listing matches every word (e.g. "DFA Cebu" with no Cebu office listed),
    // rank listings matching any word, best matches first.
    const anyWord = ftsQuery(p.q ?? "", "OR");
    if (rows.length === 0 && anyWord && anyWord !== fts) {
      const fallback = await db
        .prepare(sql)
        .bind(...binds, norm, anyWord, limit + 1, offset)
        .all<EntityRow>();
      rows = fallback.results;
    }
  } else {
    const sql = `${ENTITY_SELECT} WHERE 1 = 1 ${filters}
      ORDER BY COALESCE(s.counted_12m, 0) DESC, e.type = 'AGENCY' DESC, e.name LIMIT ?6 OFFSET ?7`;
    const res = await db
      .prepare(sql)
      .bind(...binds, limit + 1, offset)
      .all<EntityRow>();
    rows = res.results;
  }
  const hasMore = rows.length > limit;
  return { items: rows.slice(0, limit).map(toSummary), nextCursor: hasMore ? encodeCursor(offset + limit) : null };
}

export type EntityLookup = { kind: "found"; entity: EntityDetail } | { kind: "redirect"; slug: string; type: EntityType } | null;

export async function entityBySlug(db: D1Database, country: string, slug: string): Promise<EntityLookup> {
  const row = await db.prepare(`${ENTITY_SELECT} WHERE e.country_code = ?1 AND e.slug = ?2`).bind(country, slug).first<EntityRow>();
  if (row) {
    if (row.status === "MERGED" && row.merged_into_id) {
      const target = await db.prepare(`SELECT slug, type FROM entities WHERE id = ?1`).bind(row.merged_into_id).first<{ slug: string; type: EntityType }>();
      if (target) return { kind: "redirect", slug: target.slug, type: target.type };
    }
    if (row.status === "HIDDEN") return null;
    return { kind: "found", entity: await hydrateDetail(db, row) };
  }
  const legacy = await db
    .prepare(
      `SELECT e.slug, e.type FROM entity_slug_history h JOIN entities e ON e.id = h.entity_id WHERE h.country_code = ?1 AND h.slug = ?2`,
    )
    .bind(country, slug)
    .first<{ slug: string; type: EntityType }>();
  return legacy ? { kind: "redirect", slug: legacy.slug, type: legacy.type } : null;
}

export async function entityById(db: D1Database, id: string): Promise<EntityDetail | null> {
  const row = await db.prepare(`${ENTITY_SELECT} WHERE e.id = ?1 AND e.status != 'HIDDEN'`).bind(id).first<EntityRow>();
  return row ? hydrateDetail(db, row) : null;
}

async function hydrateDetail(db: D1Database, row: EntityRow): Promise<EntityDetail> {
  const [parent, aliases, sources, children, crumbs, branch] = await Promise.all([
    row.parent_entity_id
      ? db
          .prepare(`SELECT id, name, slug, type, acronym FROM entities WHERE id = ?1`)
          .bind(row.parent_entity_id)
          .first<{ id: string; name: string; slug: string; type: EntityType; acronym: string | null }>()
      : Promise.resolve(null),
    db.prepare(`SELECT alias FROM entity_aliases WHERE entity_id = ?1 ORDER BY kind, alias`).bind(row.id).all<{ alias: string }>(),
    db
      .prepare(`SELECT source_url, publisher, checked_at, status FROM entity_sources WHERE entity_id = ?1 ORDER BY checked_at DESC`)
      .bind(row.id)
      .all<{ source_url: string; publisher: string; checked_at: string | null; status: string }>(),
    db
      .prepare(`${ENTITY_SELECT} WHERE e.parent_entity_id = ?1 AND e.status = 'ACTIVE' ORDER BY COALESCE(s.counted_12m, 0) DESC, e.name LIMIT 24`)
      .bind(row.id)
      .all<EntityRow>(),
    db
      .prepare(
        `SELECT id, name, type FROM geo_units WHERE id IN (?1, ?2, ?3, ?4)
          ORDER BY CASE type WHEN 'REGION' THEN 0 WHEN 'PROVINCE' THEN 1 WHEN 'CITY' THEN 2 WHEN 'MUNICIPALITY' THEN 2 ELSE 3 END`,
      )
      .bind(row.region_id, row.province_id, row.city_id, row.geo_unit_id)
      .all<{ id: string; name: string; type: string }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS entities, COALESCE(SUM(s.counted_12m), 0) AS ratings, COALESCE(SUM(s.sum_12m), 0) AS total
           FROM entities e LEFT JOIN entity_public_stats s ON s.entity_id = e.id
          WHERE e.parent_entity_id = ?1 AND e.status = 'ACTIVE'`,
      )
      .bind(row.id)
      .first<{ entities: number; ratings: number; total: number }>(),
  ]);
  const summary = toSummary(row);
  return {
    ...summary,
    countryCode: row.country_code,
    description: row.description,
    officialUrl: row.official_url,
    address: row.address,
    status: row.status,
    ratable: row.ratable === 1 && row.status === "ACTIVE",
    verifiedAt: row.verified_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    parent: parent ?? null,
    breadcrumbs: crumbs.results,
    aliases: aliases.results.map((a) => a.alias).filter((a) => a !== row.acronym),
    sources: sources.results.map((s) => ({ url: s.source_url, publisher: s.publisher, checkedAt: s.checked_at, status: s.status })),
    children: children.results.map(toSummary),
    childCount: branch?.entities ?? 0,
    geoIds: { regionId: row.region_id, provinceId: row.province_id, cityId: row.city_id },
    branchSummary:
      branch && branch.entities > 0
        ? { entities: branch.entities, ratings: branch.ratings, mean: branch.ratings > 0 ? branch.total / branch.ratings : null }
        : null,
  };
}

/** Other listings in the same city (or province / region when the listing has no city), most-rated first. */
export async function nearbyEntities(db: D1Database, entity: EntityDetail, limit = 6): Promise<EntitySummary[]> {
  const col = entity.geoIds.cityId ? "city_id" : entity.geoIds.provinceId ? "province_id" : entity.geoIds.regionId ? "region_id" : null;
  const id = entity.geoIds.cityId ?? entity.geoIds.provinceId ?? entity.geoIds.regionId;
  if (!col || !id) return [];
  const { results } = await db
    .prepare(
      `${ENTITY_SELECT} WHERE e.${col} = ?1 AND e.id != ?2 AND e.status = 'ACTIVE' AND e.type != 'LGU'
        ORDER BY COALESCE(s.counted_12m, 0) DESC, e.name LIMIT ?3`,
    )
    .bind(id, entity.id, limit)
    .all<EntityRow>();
  return results.map(toSummary);
}

export async function recentlyAdded(db: D1Database, country: string, limit = 6): Promise<EntitySummary[]> {
  const { results } = await db
    .prepare(`${ENTITY_SELECT} WHERE e.country_code = ?1 AND e.status = 'ACTIVE' ORDER BY e.created_at DESC, e.name LIMIT ?2`)
    .bind(country, limit)
    .all<EntityRow>();
  return results.map(toSummary);
}

export async function directoryCounts(db: D1Database, country: string) {
  const [row, geo, counted] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN type IN ('AGENCY', 'OTHER_PUBLIC_BODY') THEN 1 ELSE 0 END) AS national,
                SUM(CASE WHEN type = 'LGU' THEN 1 ELSE 0 END) AS lgus,
                SUM(CASE WHEN type IN ('FIELD_OFFICE', 'LGU_OFFICE', 'BARANGAY_OFFICE') THEN 1 ELSE 0 END) AS offices,
                SUM(CASE WHEN verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified
           FROM entities WHERE country_code = ?1 AND status = 'ACTIVE'`,
      )
      .bind(country)
      .first<{ total: number; national: number; lgus: number; offices: number; verified: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM geo_units WHERE country_code = ?1`).bind(country).first<{ n: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(s.counted_12m), 0) AS n, COUNT(CASE WHEN s.counted_12m > 0 THEN 1 END) AS rated
           FROM entity_public_stats s JOIN entities e ON e.id = s.entity_id WHERE e.country_code = ?1 AND e.status = 'ACTIVE'`,
      )
      .bind(country)
      .first<{ n: number; rated: number }>(),
  ]);
  return { ...(row ?? { total: 0, national: 0, lgus: 0, offices: 0, verified: 0 }), places: geo?.n ?? 0, counted12m: counted?.n ?? 0, rated12m: counted?.rated ?? 0 };
}

export type RankingKind = "best" | "lowest" | "most";

export interface RankingView {
  cohort: RankingCohort;
  period: Period;
  kind: RankingKind;
  rows: Array<SnapshotRow & { qualified?: boolean }>;
  totalQualified: number;
  cohortMean: number | null;
  cohortRatings: number;
  generatedAt: string | null;
  methodologyVersion: string;
  minVotes: number;
  priorStrength: number;
  nextCursor: string | null;
}

export async function rankings(
  kv: KVNamespace,
  country: string,
  opts: { cohort: RankingCohort; period: Period; kind: RankingKind; regionId?: string | null; provinceId?: string | null; cityId?: string | null; offset?: number; limit?: number },
): Promise<RankingView> {
  const snap = await kv.get<RankingSnapshot>(`rankings:${country}:${opts.cohort}:${opts.period}`, { type: "json", cacheTtl: 60 });
  const empty: RankingView = {
    ...opts,
    rows: [],
    totalQualified: 0,
    cohortMean: null,
    cohortRatings: 0,
    generatedAt: null,
    methodologyVersion: METHODOLOGY_VERSION,
    minVotes: SCORING.minRankingVotes,
    priorStrength: SCORING.priorStrength,
    nextCursor: null,
  };
  if (!snap) return empty;
  const geoFilter = (r: SnapshotRow) =>
    (!opts.regionId || r.regionId === opts.regionId) &&
    (!opts.provinceId || r.provinceId === opts.provinceId) &&
    (!opts.cityId || r.cityId === opts.cityId);
  const source = opts.kind === "best" ? snap.best : opts.kind === "lowest" ? snap.lowest : snap.mostRated;
  const filtered = (source as SnapshotRow[]).filter(geoFilter).map((r, i) => ({ ...r, rank: i + 1 }));
  const limit = Math.min(100, opts.limit ?? 25);
  const offset = opts.offset ?? 0;
  return {
    ...empty,
    rows: filtered.slice(offset, offset + limit),
    totalQualified: snap.best.filter(geoFilter).length,
    cohortMean: snap.cohortMean,
    cohortRatings: snap.cohortRatings,
    generatedAt: snap.generatedAt,
    methodologyVersion: snap.methodologyVersion,
    minVotes: snap.minVotes,
    priorStrength: snap.priorStrength,
    nextCursor: filtered.length > offset + limit ? encodeCursor(offset + limit) : null,
  };
}

export function parseCohort(value: string | null, fallback: RankingCohort = "AGENCY"): RankingCohort {
  return isRankingCohort(value) ? value : fallback;
}

export function parsePeriod(value: string | null): Period {
  return value === "all" ? "all" : "12m";
}

export function typesForScope(scope: string | null, type: string | null): EntityType[] {
  if (type && isEntityType(type)) return [type];
  if (scope && scope in QUICK_FILTERS) return [...QUICK_FILTERS[scope as QuickFilter].types];
  return [];
}

export async function transparencyReport(kv: KVNamespace, country: string) {
  return kv.get<Record<string, number | string>>(`transparency:${country}`, { type: "json", cacheTtl: 300 });
}

export { ENTITY_TYPES };
