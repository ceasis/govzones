-- GovZones restricted identity database (D1 binding: IDENTITY).
-- Bound ONLY to the Account/Eligibility Worker.
-- Never stores: votes, rated entity IDs, nullifiers, scores, ballot receipts,
-- identity secrets, profile names, avatars or e-mail addresses.

CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('email')),
  -- HMAC-SHA256(SUBJECT_PEPPER, 'email:' || normalised address). The address itself is never stored.
  provider_subject_protected TEXT NOT NULL UNIQUE,
  created_day TEXT NOT NULL,          -- day granularity only (YYYY-MM-DD)
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED'))
);

CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY,      -- SHA-256 of the opaque cookie value
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

-- One-time sign-in codes. Keyed by the same protected hash as accounts; the address is used only
-- to send the code and is never written here.
CREATE TABLE email_sign_in_codes (
  id TEXT PRIMARY KEY,
  email_protected TEXT NOT NULL,
  code_hash TEXT NOT NULL,            -- SHA-256(id || ':' || code)
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT
);
CREATE INDEX email_sign_in_codes_email ON email_sign_in_codes(email_protected, created_at);
CREATE INDEX email_sign_in_codes_expiry ON email_sign_in_codes(expires_at);

-- One active public commitment per provider account per country.
CREATE TABLE identity_enrollments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  country_code TEXT NOT NULL,
  public_commitment TEXT NOT NULL,
  enrolled_day TEXT NOT NULL,         -- coarse date only
  eligible_for_countable_after TEXT NOT NULL,
  revoked_at TEXT,
  trust_group_state TEXT NOT NULL DEFAULT 'SUBMIT' CHECK (trust_group_state IN ('SUBMIT', 'COUNTABLE', 'REVOKED'))
);
CREATE UNIQUE INDEX identity_enrollments_active ON identity_enrollments(account_id, country_code) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX identity_enrollments_commitment ON identity_enrollments(country_code, public_commitment);
CREATE INDEX identity_enrollments_trust ON identity_enrollments(trust_group_state, eligible_for_countable_after) WHERE revoked_at IS NULL;

-- Optional ciphertext-only wallet backups. The object lives in R2; the server never holds a decryption key.
CREATE TABLE encrypted_wallet_backups (
  account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  ciphertext_object_key TEXT NOT NULL,
  backup_version INTEGER NOT NULL,
  updated_day TEXT NOT NULL
);

-- Pre-ballot trust signals only. No nullifiers, no agency IDs, no scores.
CREATE TABLE enrollment_risk_actions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  risk_reason_code TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('HOLD_SUBMIT_ONLY', 'BLOCK_ENROLLMENT', 'CLEARED')),
  case_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX enrollment_risk_actions_account ON enrollment_risk_actions(account_id, expires_at);

-- Coarse, short-lived enrollment velocity buckets for burst detection (no per-account timestamps).
CREATE TABLE enrollment_velocity (
  bucket TEXT PRIMARY KEY,            -- e.g. PH:2026-10-31T14
  count INTEGER NOT NULL
);

-- Lost-wallet reset requests. A reset never silently enrolls a new identity:
-- staff approve it, the old commitment is revoked, and the new one stays submit-only for a long hold.
CREATE TABLE wallet_reset_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  country_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  created_day TEXT NOT NULL,
  reviewed_at TEXT,
  case_ref TEXT
);
CREATE UNIQUE INDEX wallet_reset_pending ON wallet_reset_requests(account_id, country_code) WHERE status = 'PENDING';

-- After account deletion, a re-created account for the same provider subject may enroll,
-- but is held in the Submit Group (not counted) until this tombstone expires.
-- Requires Philippine privacy-law review (retention of a pseudonymous key after erasure).
CREATE TABLE deleted_account_tombstones (
  provider_subject_protected TEXT PRIMARY KEY,
  hold_until TEXT NOT NULL
);

-- Per-account abuse quota for suggestions/corrections (account side only; never ballots).
CREATE TABLE account_quota (
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (account_id, bucket)
);

CREATE TABLE identity_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  case_ref TEXT,
  created_at TEXT NOT NULL,
  summary TEXT NOT NULL
);
