-- GovZones group-membership / root registry (D1 binding: GROUPS).
-- Separate trust boundary: only public commitments and published roots.
-- Never receives account IDs, targeted agencies, nullifiers or ballots.

-- Append-only leaf log per (country, group). Leaf order defines the Merkle tree.
CREATE TABLE group_memberships (
  country_code TEXT NOT NULL,
  group_id TEXT NOT NULL CHECK (group_id IN ('submit', 'countable')),
  public_commitment TEXT NOT NULL,
  leaf_index INTEGER,                 -- assigned at batch publication
  joined_epoch INTEGER,               -- NULL while pending the next batch
  revoked_epoch INTEGER,
  revoke_pending INTEGER NOT NULL DEFAULT 0 CHECK (revoke_pending IN (0, 1)),
  PRIMARY KEY (country_code, group_id, public_commitment)
);
CREATE UNIQUE INDEX group_memberships_leaf ON group_memberships(country_code, group_id, leaf_index) WHERE leaf_index IS NOT NULL;
CREATE INDEX group_memberships_pending ON group_memberships(country_code, group_id, joined_epoch);

CREATE TABLE group_root_snapshots (
  country_code TEXT NOT NULL,
  group_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  root TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  leaf_count INTEGER NOT NULL,
  proof_depth INTEGER NOT NULL,
  anonymity_ok INTEGER NOT NULL CHECK (anonymity_ok IN (0, 1)),
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  superseded_at TEXT,
  revoked_at TEXT,
  snapshot_key TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  signed_payload TEXT NOT NULL,
  signature TEXT NOT NULL,
  PRIMARY KEY (country_code, group_id, epoch)
);
CREATE UNIQUE INDEX group_root_snapshots_root ON group_root_snapshots(country_code, group_id, root, epoch);
CREATE INDEX group_root_snapshots_validity ON group_root_snapshots(group_id, epoch, valid_until);

CREATE TABLE root_publication_jobs (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  group_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('STARTED', 'PUBLISHED', 'SKIPPED', 'FAILED')),
  detail TEXT,
  published_at TEXT,
  UNIQUE (country_code, group_id, epoch)
);
