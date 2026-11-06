-- GovZones anonymous votes database, Philippines shard 00 (D1 binding: VOTES).
-- Bound ONLY to the Anonymous Ballot Worker and the aggregate consumer.
-- Contains NO account fields, provider subjects, session data, IP addresses or account-derived tags.

CREATE TABLE anonymous_ballots (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  scoped_nullifier TEXT NOT NULL,
  score INTEGER CHECK (score IS NULL OR (score BETWEEN 1 AND 10)),
  status TEXT NOT NULL CHECK (status IN ('RECEIVED', 'PROVISIONAL', 'COUNTED', 'QUARANTINED', 'EXCLUDED', 'DELETED')),
  trust_group TEXT NOT NULL CHECK (trust_group IN ('submit', 'countable')),
  root_epoch INTEGER NOT NULL,
  root_anonymity_ok INTEGER NOT NULL CHECK (root_anonymity_ok IN (0, 1)),
  held_since TEXT NOT NULL,           -- start of the 24-hour maturation hold
  last_scored_at TEXT NOT NULL,       -- drives the 30-day edit cooldown and the 12-month window
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  CHECK (status = 'DELETED' OR score IS NOT NULL)
);
-- Exactly one record per (entity, nullifier): concurrent proofs can never create a second active rating.
CREATE UNIQUE INDEX anonymous_ballots_entity_nullifier ON anonymous_ballots(country_code, entity_id, scoped_nullifier);
CREATE INDEX anonymous_ballots_entity_status ON anonymous_ballots(entity_id, status, updated_at);
CREATE INDEX anonymous_ballots_maturation ON anonymous_ballots(status, trust_group, held_since);

CREATE TABLE proof_challenges (
  challenge_hash TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('UPSERT', 'DELETE', 'APPEAL')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX proof_challenges_expiry ON proof_challenges(expires_at);

CREATE TABLE ballot_receipts (
  receipt_hash TEXT PRIMARY KEY,
  ballot_id TEXT NOT NULL REFERENCES anonymous_ballots(id),
  created_at TEXT NOT NULL
);
CREATE INDEX ballot_receipts_ballot ON ballot_receipts(ballot_id);

CREATE TABLE ballot_risk_cases (
  case_id TEXT PRIMARY KEY,
  ballot_id TEXT NOT NULL REFERENCES anonymous_ballots(id),
  entity_id TEXT NOT NULL,
  reason_codes TEXT NOT NULL,         -- JSON array of ballot-level evidence categories
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'APPEALED', 'CLEARED', 'EXCLUDED')),
  opened_by TEXT NOT NULL,            -- 'auto:<rule>' or staff role
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewer_ref TEXT,
  resolution_note TEXT
);
CREATE INDEX ballot_risk_cases_state ON ballot_risk_cases(state, created_at);
CREATE INDEX ballot_risk_cases_ballot ON ballot_risk_cases(ballot_id);

CREATE TABLE ballot_appeals (
  id TEXT PRIMARY KEY,
  ballot_id TEXT NOT NULL REFERENCES anonymous_ballots(id),
  case_id TEXT,
  created_at TEXT NOT NULL
);

-- Derived ONLY from COUNTED ballots; rebuildable.
CREATE TABLE aggregate_metrics (
  entity_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('12m', 'all')),
  counted_count INTEGER NOT NULL,
  score_sum INTEGER NOT NULL,
  raw_mean REAL,
  histogram TEXT NOT NULL,
  source_version TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (period, entity_id)
);

-- Idempotency/audit for at-least-once queue delivery.
CREATE TABLE aggregate_jobs (
  event_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  result_version TEXT NOT NULL
);

-- Aggregate-only moderation transparency counters (no ballot-level data).
CREATE TABLE moderation_audit (
  id TEXT PRIMARY KEY,
  case_id TEXT,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor_role TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT
);
