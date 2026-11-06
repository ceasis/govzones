/** Rebuilds the FTS row for one entity (names, acronym, aliases, parent, place names). */
export const REBUILD_SEARCH_ROW_SQL = [
  `DELETE FROM entity_search WHERE entity_id = ?1`,
  `INSERT INTO entity_search (entity_id, name, acronym, aliases, place)
   SELECT e.id, e.name, COALESCE(e.acronym, ''),
          trim(COALESCE((SELECT group_concat(a.alias, ' ') FROM entity_aliases a WHERE a.entity_id = e.id), '') || ' ' ||
               COALESCE(pe.acronym, '') || ' ' || COALESCE(pe.name, '')),
          trim(COALESCE(g.name, '') || ' ' || COALESCE(c.name, '') || ' ' || COALESCE(pr.name, '') || ' ' ||
               COALESCE(r.name, '') || ' ' || COALESCE(r.short_name, ''))
     FROM entities e
     LEFT JOIN entities pe ON pe.id = e.parent_entity_id
     LEFT JOIN geo_units g ON g.id = e.geo_unit_id
     LEFT JOIN geo_units c ON c.id = e.city_id AND c.id <> e.geo_unit_id
     LEFT JOIN geo_units pr ON pr.id = e.province_id AND pr.id <> e.geo_unit_id
     LEFT JOIN geo_units r ON r.id = e.region_id AND r.id <> e.geo_unit_id
    WHERE e.id = ?1`,
];

/** Resolves region/province/city ancestors for a geo unit (up to 4 levels). */
export const GEO_ANCESTORS_SQL = `
  WITH RECURSIVE chain(id, parent_id, type, depth) AS (
    SELECT id, parent_id, type, 0 FROM geo_units WHERE id = ?1
    UNION ALL
    SELECT g.id, g.parent_id, g.type, chain.depth + 1 FROM geo_units g JOIN chain ON g.id = chain.parent_id WHERE chain.depth < 6
  )
  SELECT id, type FROM chain`;

export function ancestorsFrom(rows: Array<{ id: string; type: string }>) {
  const pick = (types: string[]) => rows.find((r) => types.includes(r.type))?.id ?? null;
  return {
    regionId: pick(["REGION"]),
    provinceId: pick(["PROVINCE"]),
    cityId: pick(["CITY", "MUNICIPALITY"]),
  };
}
