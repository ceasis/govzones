-- GovZones canonical directory database (D1 binding: DIRECTORY).
-- Public, source-backed records only. No account identifiers, no ballots.

CREATE TABLE countries (
  code TEXT PRIMARY KEY CHECK (length(code) = 2 AND code = upper(code)),
  name TEXT NOT NULL,
  path_segment TEXT NOT NULL UNIQUE,
  default_language TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PLANNED', 'DISABLED'))
);

CREATE TABLE geo_units (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES countries(code),
  parent_id TEXT REFERENCES geo_units(id),
  type TEXT NOT NULL CHECK (type IN ('REGION', 'PROVINCE', 'CITY', 'MUNICIPALITY', 'SUB_MUNICIPALITY', 'BARANGAY')),
  official_code TEXT,
  name TEXT NOT NULL,
  short_name TEXT,
  city_class TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX geo_units_official_code ON geo_units(country_code, official_code) WHERE official_code IS NOT NULL;
CREATE INDEX geo_units_parent ON geo_units(country_code, parent_id, type);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES countries(code),
  type TEXT NOT NULL CHECK (type IN ('AGENCY', 'FIELD_OFFICE', 'LGU', 'LGU_OFFICE', 'BARANGAY_OFFICE', 'OTHER_PUBLIC_BODY')),
  parent_entity_id TEXT REFERENCES entities(id),
  geo_unit_id TEXT REFERENCES geo_units(id),
  -- Denormalised ancestors so filters do not need recursive queries.
  region_id TEXT REFERENCES geo_units(id),
  province_id TEXT REFERENCES geo_units(id),
  city_id TEXT REFERENCES geo_units(id),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  acronym TEXT,
  slug TEXT NOT NULL,
  description TEXT,
  official_url TEXT,
  address TEXT,
  official_ids TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PENDING', 'MERGED', 'CLOSED', 'HIDDEN')),
  ratable INTEGER NOT NULL DEFAULT 1 CHECK (ratable IN (0, 1)),
  merged_into_id TEXT REFERENCES entities(id),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (parent_entity_id IS NULL OR parent_entity_id <> id)
);
CREATE UNIQUE INDEX entities_country_slug ON entities(country_code, slug);
CREATE INDEX entities_browse ON entities(country_code, type, geo_unit_id, status);
CREATE INDEX entities_region ON entities(country_code, region_id, type, status);
CREATE INDEX entities_province ON entities(country_code, province_id, type, status);
CREATE INDEX entities_city ON entities(country_code, city_id, type, status);
CREATE INDEX entities_parent ON entities(parent_entity_id);
CREATE INDEX entities_created ON entities(country_code, status, created_at);
CREATE INDEX entities_normalized_name ON entities(country_code, normalized_name);

-- Legacy slugs keep redirecting after renames/merges.
CREATE TABLE entity_slug_history (
  country_code TEXT NOT NULL,
  slug TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  retired_at TEXT NOT NULL,
  PRIMARY KEY (country_code, slug)
);

CREATE TABLE entity_aliases (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ALIAS' CHECK (kind IN ('ACRONYM', 'ALIAS', 'FORMER_NAME', 'LOCAL_NAME')),
  UNIQUE (entity_id, normalized_alias)
);
CREATE INDEX entity_aliases_normalized ON entity_aliases(normalized_alias);

CREATE TABLE entity_sources (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  publisher TEXT NOT NULL,
  checked_at TEXT,
  status TEXT NOT NULL DEFAULT 'UNCHECKED' CHECK (status IN ('UNCHECKED', 'CURRENT', 'STALE', 'BROKEN', 'SUPERSEDED')),
  note TEXT
);
CREATE INDEX entity_sources_entity ON entity_sources(entity_id);

-- Public aggregates derived ONLY from COUNTED ballots by the aggregator.
-- Rebuildable at any time from the votes database; never authoritative.
CREATE TABLE entity_public_stats (
  entity_id TEXT PRIMARY KEY REFERENCES entities(id),
  country_code TEXT NOT NULL,
  counted_all INTEGER NOT NULL DEFAULT 0,
  sum_all INTEGER NOT NULL DEFAULT 0,
  counted_12m INTEGER NOT NULL DEFAULT 0,
  sum_12m INTEGER NOT NULL DEFAULT 0,
  histogram_all TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0]',
  histogram_12m TEXT NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0]',
  computed_at TEXT NOT NULL,
  methodology_version TEXT NOT NULL
);
CREATE INDEX entity_public_stats_count ON entity_public_stats(country_code, counted_12m);

-- Staff-only, retention-limited. Deliberately no submitter/account identity.
CREATE TABLE entity_suggestions (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  suggested_name TEXT NOT NULL,
  suggested_type TEXT NOT NULL,
  parent_entity_id TEXT,
  geo_unit_id TEXT,
  address TEXT,
  source_url TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'IN_REVIEW', 'ACCEPTED', 'REJECTED', 'DUPLICATE')),
  resolution_note TEXT,
  resulting_entity_id TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX entity_suggestions_status ON entity_suggestions(status, created_at);

CREATE TABLE entity_corrections (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  field TEXT NOT NULL,
  details TEXT NOT NULL,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'ACCEPTED', 'REJECTED')),
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX entity_corrections_status ON entity_corrections(status, created_at);

CREATE TABLE directory_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_id TEXT,
  actor_role TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  case_ref TEXT,
  created_at TEXT NOT NULL,
  change_summary TEXT NOT NULL
);
CREATE INDEX directory_audit_entity ON directory_audit(entity_id, created_at);

-- Full-text search over names, acronyms, aliases and place names.
-- Maintained by application code (seed builder, admin edits).
CREATE VIRTUAL TABLE entity_search USING fts5(
  entity_id UNINDEXED,
  name,
  acronym,
  aliases,
  place,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
