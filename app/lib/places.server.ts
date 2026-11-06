/**
 * Geographic browsing (server only): regions → provinces → cities / municipalities, each with the
 * number of active listings located inside it. Entities carry denormalised region_id / province_id /
 * city_id, so "inside" is a plain column match at every level.
 */
import type { GeoUnit } from "./data.server";

export interface PlaceSummary extends GeoUnit {
  listings: number;
}

export interface PlaceIndexEntry {
  id: string;
  type: string;
  name: string;
  shortName: string | null;
  parentName: string | null;
  regionShort: string | null;
}

export const BROWSABLE_GEO_TYPES = ["REGION", "PROVINCE", "CITY", "MUNICIPALITY"] as const;

interface GeoRow {
  id: string;
  type: string;
  name: string;
  short_name: string | null;
  parent_id: string | null;
  listings?: number;
}

const toUnit = (g: GeoRow): GeoUnit => ({ id: g.id, type: g.type, name: g.name, shortName: g.short_name, parentId: g.parent_id });
const toPlace = (g: GeoRow): PlaceSummary => ({ ...toUnit(g), listings: Number(g.listings ?? 0) });

/** Active listings located anywhere inside the unit (works at every level). */
const LISTINGS_SUBQUERY = `(SELECT COUNT(*) FROM entities e
    WHERE e.country_code = g.country_code AND e.status = 'ACTIVE'
      AND (e.region_id = g.id OR e.province_id = g.id OR e.city_id = g.id OR e.geo_unit_id = g.id))`;

export async function regionsWithCounts(db: D1Database, country: string): Promise<PlaceSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.type, g.name, g.short_name, g.parent_id, ${LISTINGS_SUBQUERY} AS listings
         FROM geo_units g WHERE g.country_code = ?1 AND g.type = 'REGION' ORDER BY g.sort_order, g.name`,
    )
    .bind(country)
    .all<GeoRow>();
  return results.map(toPlace);
}

/** Flat list of provinces, cities and municipalities for the client-side "find a place" filter. */
export async function placeIndex(db: D1Database, country: string): Promise<PlaceIndexEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.type, g.name, g.short_name, p.name AS parent_name,
              CASE WHEN p.type = 'REGION' THEN p.short_name ELSE r.short_name END AS region_short
         FROM geo_units g
         LEFT JOIN geo_units p ON p.id = g.parent_id
         LEFT JOIN geo_units r ON r.id = p.parent_id
        WHERE g.country_code = ?1 AND g.type IN ('PROVINCE', 'CITY', 'MUNICIPALITY')
        ORDER BY g.name LIMIT 2000`,
    )
    .bind(country)
    .all<{ id: string; type: string; name: string; short_name: string | null; parent_name: string | null; region_short: string | null }>();
  return results.map((g) => ({ id: g.id, type: g.type, name: g.name, shortName: g.short_name, parentName: g.parent_name, regionShort: g.region_short }));
}

export async function placeById(db: D1Database, country: string, id: string): Promise<PlaceSummary | null> {
  const g = await db
    .prepare(
      `SELECT g.id, g.type, g.name, g.short_name, g.parent_id, ${LISTINGS_SUBQUERY} AS listings
         FROM geo_units g WHERE g.id = ?1 AND g.country_code = ?2 AND g.type IN ('REGION', 'PROVINCE', 'CITY', 'MUNICIPALITY')`,
    )
    .bind(id, country)
    .first<GeoRow>();
  return g ? toPlace(g) : null;
}

/** Parent chain, outermost first (region, then province). */
export async function placeAncestors(db: D1Database, unit: GeoUnit): Promise<GeoUnit[]> {
  const chain: GeoUnit[] = [];
  let parentId = unit.parentId;
  for (let i = 0; i < 4 && parentId; i++) {
    const g = await db
      .prepare(`SELECT id, type, name, short_name, parent_id FROM geo_units WHERE id = ?1`)
      .bind(parentId)
      .first<GeoRow>();
    if (!g) break;
    chain.unshift(toUnit(g));
    parentId = g.parent_id;
  }
  return chain;
}

export async function placeChildren(db: D1Database, country: string, parentId: string): Promise<PlaceSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.type, g.name, g.short_name, g.parent_id, ${LISTINGS_SUBQUERY} AS listings
         FROM geo_units g WHERE g.country_code = ?1 AND g.parent_id = ?2 AND g.type IN ('PROVINCE', 'CITY', 'MUNICIPALITY')
        ORDER BY g.sort_order, g.name LIMIT 500`,
    )
    .bind(country, parentId)
    .all<GeoRow>();
  return results.map(toPlace);
}

/** The search / ranking filter that selects everything inside a unit. */
export function geoFilterFor(unit: GeoUnit): { regionId?: string; provinceId?: string; cityId?: string } {
  if (unit.type === "REGION") return { regionId: unit.id };
  if (unit.type === "PROVINCE") return { provinceId: unit.id };
  return { cityId: unit.id };
}

/** Query-string parameter the search page uses for this unit. */
export function searchParamFor(unit: GeoUnit): "region" | "province" | "city" {
  if (unit.type === "REGION") return "region";
  if (unit.type === "PROVINCE") return "province";
  return "city";
}
