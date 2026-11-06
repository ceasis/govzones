/** Directory vocabulary shared by the public site, workers and scripts. */

export const ENTITY_TYPES = [
  "AGENCY",
  "FIELD_OFFICE",
  "LGU",
  "LGU_OFFICE",
  "BARANGAY_OFFICE",
  "OTHER_PUBLIC_BODY",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === "string" && (ENTITY_TYPES as readonly string[]).includes(value);
}

export const ENTITY_TYPE_LABEL: Record<EntityType, string> = {
  AGENCY: "National agency",
  FIELD_OFFICE: "Service office",
  LGU: "Local government",
  LGU_OFFICE: "Local government office",
  BARANGAY_OFFICE: "Barangay office",
  OTHER_PUBLIC_BODY: "Government corporation",
};

export const ENTITY_TYPE_PLURAL: Record<EntityType, string> = {
  AGENCY: "National agencies",
  FIELD_OFFICE: "Service offices",
  LGU: "Local governments",
  LGU_OFFICE: "Local government offices",
  BARANGAY_OFFICE: "Barangay offices",
  OTHER_PUBLIC_BODY: "Government corporations",
};

/** Organisation-level entities live under /agency/, physical/local offices under /office/. */
export function entityPathKind(type: EntityType): "agency" | "office" {
  return type === "AGENCY" || type === "LGU" || type === "OTHER_PUBLIC_BODY" ? "agency" : "office";
}

export function entityPath(countrySegment: string, type: EntityType, slug: string): string {
  return `/${countrySegment}/${entityPathKind(type)}/${slug}`;
}

/** Quick filters on the homepage map to these type sets. */
export const QUICK_FILTERS = {
  national: { label: "National agencies", types: ["AGENCY", "OTHER_PUBLIC_BODY"] as EntityType[] },
  local: { label: "Local government", types: ["LGU", "LGU_OFFICE", "BARANGAY_OFFICE"] as EntityType[] },
  offices: { label: "Service offices", types: ["FIELD_OFFICE", "LGU_OFFICE"] as EntityType[] },
} as const;
export type QuickFilter = keyof typeof QUICK_FILTERS;

/**
 * Ranking cohorts compare like with like. A cohort's mean is the Bayesian prior.
 * "mixed" is only shown when explicitly chosen and uses each entity's own type cohort mean.
 */
export const RANKING_COHORTS = ["AGENCY", "OTHER_PUBLIC_BODY", "LGU", "FIELD_OFFICE", "LGU_OFFICE", "BARANGAY_OFFICE", "mixed"] as const;
export type RankingCohort = (typeof RANKING_COHORTS)[number];

export function isRankingCohort(value: unknown): value is RankingCohort {
  return typeof value === "string" && (RANKING_COHORTS as readonly string[]).includes(value);
}

export const COHORT_LABEL: Record<RankingCohort, string> = {
  ...ENTITY_TYPE_PLURAL,
  mixed: "All types (mixed view)",
};

export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function slugify(value: string): string {
  return normalizeText(value).replace(/ /g, "-").slice(0, 96).replace(/-+$/, "");
}

/** Builds a safe FTS5 MATCH expression: every token (or, with OR, any token) must match as a prefix. */
export function ftsQuery(q: string, joiner: "AND" | "OR" = "AND"): string | null {
  const tokens = normalizeText(q)
    .split(" ")
    .filter((t) => t.length > 0)
    .slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(joiner === "OR" ? " OR " : " ");
}

/** Human labels for geo_units.type (shared by server loaders and client components). */
export const GEO_TYPE_LABEL: Record<string, string> = {
  REGION: "Region",
  PROVINCE: "Province",
  CITY: "City",
  MUNICIPALITY: "Municipality",
  SUB_MUNICIPALITY: "District",
  BARANGAY: "Barangay",
};
