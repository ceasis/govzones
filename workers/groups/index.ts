/**
 * GovZones Group Manager Worker.
 *
 * Trust boundary: holds ONLY public identity commitments and published roots.
 * It never receives account IDs, targeted agencies, nullifiers or ballots.
 *
 * - Public (via the web worker): GET /api/v1/groups/roots, GET /api/v1/groups/snapshot/:root
 * - RPC `GroupMembership` (bound only by the Account Worker): add / revoke commitments
 * - RPC `GroupRoots` (bound by the Ballot Worker): currently accepted signed roots
 * - Cron: batched epoch publication with shuffled insertion order
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { Group } from "@semaphore-protocol/group";
import { isCountryCode, isFieldElementString, proofDepthFor, type GroupId } from "../../shared/protocol";
import { HttpError, errorResponse, json, nowIso } from "../../shared/http";
import { importSigningKey, sha256Hex, signRecord, type RootRecord, type SignedRoot } from "../../shared/signing";

export interface Env {
  GROUPS_DB: D1Database;
  GROUP_SNAPSHOTS: R2Bucket;
  /** ECDSA P-256 private JWK (secret). */
  ROOT_SIGNING_KEY: string;
  /** Matching public JWK (var), published so clients and the ballot worker can verify roots. */
  ROOT_PUBLIC_KEY: string;
  ACTIVE_COUNTRIES?: string;
  MIN_ANONYMITY_SET?: string;
  ROOT_VALIDITY_HOURS?: string;
  ROOT_GRACE_MINUTES?: string;
}

const GROUPS: GroupId[] = ["submit", "countable"];

interface SnapshotRow {
  country_code: string;
  group_id: GroupId;
  epoch: number;
  root: string;
  member_count: number;
  leaf_count: number;
  proof_depth: number;
  anonymity_ok: number;
  valid_from: string;
  valid_until: string;
  superseded_at: string | null;
  revoked_at: string | null;
  snapshot_key: string;
  snapshot_sha256: string;
  signed_payload: string;
  signature: string;
}

export interface AcceptedRoot extends SignedRoot {
  snapshotPath: string;
}

function countries(env: Env): string[] {
  return String(env.ACTIVE_COUNTRIES ?? "PH")
    .split(",")
    .map((c) => c.trim())
    .filter(isCountryCode);
}

function minAnonymitySet(env: Env): number {
  return Math.max(2, Number(env.MIN_ANONYMITY_SET ?? 100));
}

function toSigned(row: SnapshotRow): AcceptedRoot {
  return {
    record: JSON.parse(row.signed_payload) as RootRecord,
    payload: row.signed_payload,
    signature: row.signature,
    snapshotPath: `/api/v1/groups/snapshot/${row.root}?country=${row.country_code}&group=${row.group_id}`,
  };
}

async function acceptedRoots(env: Env, country: string, now = Date.now()): Promise<AcceptedRoot[]> {
  const graceCutoff = nowIso(now - Number(env.ROOT_GRACE_MINUTES ?? 60) * 60_000);
  const { results } = await env.GROUPS_DB.prepare(
    `SELECT * FROM group_root_snapshots
       WHERE country_code = ?1 AND revoked_at IS NULL AND valid_until > ?2
         AND (superseded_at IS NULL OR superseded_at > ?3)
       ORDER BY group_id, epoch DESC`,
  )
    .bind(country, nowIso(now), graceCutoff)
    .all<SnapshotRow>();
  return results.map(toSigned);
}

function secureShuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const r = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [out[i], out[r]] = [out[r], out[i]];
  }
  return out;
}

export interface PublishResult {
  country: string;
  group: GroupId;
  state: "PUBLISHED" | "SKIPPED";
  epoch?: number;
  memberCount?: number;
  anonymityOk?: boolean;
}

/**
 * Publishes the next epoch for one (country, group) if anything changed or the
 * current root is close to expiry. Idempotent per epoch via root_publication_jobs.
 */
async function publishEpoch(env: Env, country: string, group: GroupId, now = Date.now()): Promise<PublishResult> {
  const db = env.GROUPS_DB;
  const last = await db
    .prepare(`SELECT * FROM group_root_snapshots WHERE country_code = ?1 AND group_id = ?2 ORDER BY epoch DESC LIMIT 1`)
    .bind(country, group)
    .first<SnapshotRow>();

  // Members revoked before they were ever published are simply dropped.
  await db
    .prepare(
      `DELETE FROM group_memberships WHERE country_code = ?1 AND group_id = ?2 AND joined_epoch IS NULL AND revoke_pending = 1`,
    )
    .bind(country, group)
    .run();

  const pending = await db
    .prepare(
      `SELECT public_commitment FROM group_memberships
         WHERE country_code = ?1 AND group_id = ?2 AND joined_epoch IS NULL AND revoke_pending = 0`,
    )
    .bind(country, group)
    .all<{ public_commitment: string }>();
  const revoking = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM group_memberships
         WHERE country_code = ?1 AND group_id = ?2 AND revoke_pending = 1 AND joined_epoch IS NOT NULL`,
    )
    .bind(country, group)
    .first<{ n: number }>();

  const validityMs = Number(env.ROOT_VALIDITY_HOURS ?? 168) * 3_600_000;
  const refreshDue = !last || Date.parse(last.valid_until) - now < validityMs / 4;
  const hasChanges = pending.results.length > 0 || (revoking?.n ?? 0) > 0;
  if (!hasChanges && !refreshDue) return { country, group, state: "SKIPPED" };
  if (!last && pending.results.length === 0) return { country, group, state: "SKIPPED" };

  const epoch = (last?.epoch ?? 0) + 1;
  const jobId = crypto.randomUUID();
  const claimed = await db
    .prepare(
      `INSERT INTO root_publication_jobs (id, country_code, group_id, epoch, state) VALUES (?1, ?2, ?3, ?4, 'STARTED')
         ON CONFLICT (country_code, group_id, epoch) DO NOTHING`,
    )
    .bind(jobId, country, group, epoch)
    .run();
  if (claimed.meta.changes !== 1) return { country, group, state: "SKIPPED" };

  try {
    const existing = await db
      .prepare(
        `SELECT public_commitment, leaf_index, revoked_epoch, revoke_pending FROM group_memberships
           WHERE country_code = ?1 AND group_id = ?2 AND leaf_index IS NOT NULL ORDER BY leaf_index`,
      )
      .bind(country, group)
      .all<{ public_commitment: string; leaf_index: number; revoked_epoch: number | null; revoke_pending: number }>();

    const leaves: bigint[] = existing.results.map((m) =>
      m.revoked_epoch !== null || m.revoke_pending === 1 ? 0n : BigInt(m.public_commitment),
    );
    // Shuffle the batch so leaf order does not reveal enrollment order within an epoch.
    const joins = secureShuffle(pending.results.map((p) => p.public_commitment));
    const firstNewIndex = leaves.length;
    for (const c of joins) leaves.push(BigInt(c));

    const tree = new Group(leaves);
    const memberCount = leaves.filter((l) => l !== 0n).length;
    const anonymityOk = group === "countable" ? memberCount >= minAnonymitySet(env) : memberCount >= 2;
    const snapshot = JSON.stringify({ v: 1, country, group, epoch, leaves: leaves.map((l) => l.toString()) });
    const snapshotSha256 = await sha256Hex(snapshot);
    const snapshotKey = `${country}/${group}/${String(epoch).padStart(8, "0")}.json`;
    await env.GROUP_SNAPSHOTS.put(snapshotKey, snapshot, {
      httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=31536000, immutable" },
    });

    const record: RootRecord = {
      v: 1,
      country,
      group,
      epoch,
      root: tree.root.toString(),
      memberCount,
      leafCount: leaves.length,
      proofDepth: proofDepthFor(leaves.length),
      anonymityOk,
      validFrom: nowIso(now),
      validUntil: nowIso(now + validityMs),
      snapshotSha256,
    };
    const signed = await signRecord(record, await importSigningKey(env.ROOT_SIGNING_KEY));

    const stmts: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO group_root_snapshots
             (country_code, group_id, epoch, root, member_count, leaf_count, proof_depth, anonymity_ok,
              valid_from, valid_until, snapshot_key, snapshot_sha256, signed_payload, signature)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
        )
        .bind(
          country,
          group,
          epoch,
          record.root,
          memberCount,
          record.leafCount,
          record.proofDepth,
          anonymityOk ? 1 : 0,
          record.validFrom,
          record.validUntil,
          snapshotKey,
          snapshotSha256,
          signed.payload,
          signed.signature,
        ),
      db
        .prepare(
          `UPDATE group_root_snapshots SET superseded_at = ?1
             WHERE country_code = ?2 AND group_id = ?3 AND epoch < ?4 AND superseded_at IS NULL`,
        )
        .bind(nowIso(now), country, group, epoch),
    ];
    if ((revoking?.n ?? 0) > 0) {
      // A revocation invalidates every earlier root immediately: proofs of prior
      // membership must not keep authorizing ballots after revocation.
      stmts.push(
        db
          .prepare(
            `UPDATE group_root_snapshots SET revoked_at = ?1
               WHERE country_code = ?2 AND group_id = ?3 AND epoch < ?4 AND revoked_at IS NULL`,
          )
          .bind(nowIso(now), country, group, epoch),
        db
          .prepare(
            `UPDATE group_memberships SET revoked_epoch = ?1, revoke_pending = 0
               WHERE country_code = ?2 AND group_id = ?3 AND revoke_pending = 1 AND joined_epoch IS NOT NULL`,
          )
          .bind(epoch, country, group),
      );
    }
    joins.forEach((c, i) =>
      stmts.push(
        db
          .prepare(
            `UPDATE group_memberships SET joined_epoch = ?1, leaf_index = ?2
               WHERE country_code = ?3 AND group_id = ?4 AND public_commitment = ?5`,
          )
          .bind(epoch, firstNewIndex + i, country, group, c),
      ),
    );
    stmts.push(
      db
        .prepare(`UPDATE root_publication_jobs SET state = 'PUBLISHED', published_at = ?1 WHERE id = ?2`)
        .bind(nowIso(now), jobId),
    );
    await db.batch(stmts);
    return { country, group, state: "PUBLISHED", epoch, memberCount, anonymityOk };
  } catch (err) {
    await db
      .prepare(`UPDATE root_publication_jobs SET state = 'FAILED', detail = ?1 WHERE id = ?2`)
      .bind(err instanceof Error ? err.message.slice(0, 200) : "error", jobId)
      .run();
    throw err;
  }
}

async function publishAll(env: Env): Promise<PublishResult[]> {
  const results: PublishResult[] = [];
  for (const country of countries(env)) {
    for (const group of GROUPS) results.push(await publishEpoch(env, country, group));
  }
  return results;
}

function requireCommitment(value: unknown): string {
  if (!isFieldElementString(value) || value === "0") throw new HttpError("BAD_REQUEST", "Invalid commitment.");
  return value;
}

/** RPC surface bound ONLY by the Account/Eligibility Worker. */
export class GroupMembership extends WorkerEntrypoint<Env> {
  async addMember(country: string, commitment: string, group: GroupId): Promise<{ status: "pending" | "member" | "revoked" }> {
    if (!isCountryCode(country) || !GROUPS.includes(group)) throw new Error("invalid group");
    const c = requireCommitment(commitment);
    const existing = await this.env.GROUPS_DB.prepare(
      `SELECT joined_epoch, revoked_epoch, revoke_pending FROM group_memberships
         WHERE country_code = ?1 AND group_id = ?2 AND public_commitment = ?3`,
    )
      .bind(country, group, c)
      .first<{ joined_epoch: number | null; revoked_epoch: number | null; revoke_pending: number }>();
    if (existing) {
      if (existing.revoked_epoch !== null || existing.revoke_pending) return { status: "revoked" };
      return { status: existing.joined_epoch === null ? "pending" : "member" };
    }
    await this.env.GROUPS_DB.prepare(
      `INSERT INTO group_memberships (country_code, group_id, public_commitment) VALUES (?1, ?2, ?3)
         ON CONFLICT DO NOTHING`,
    )
      .bind(country, group, c)
      .run();
    return { status: "pending" };
  }

  /** Revokes a commitment from one group, or from every group when `group` is omitted. */
  async revokeMember(country: string, commitment: string, group?: GroupId): Promise<{ revoked: number }> {
    if (!isCountryCode(country)) throw new Error("invalid country");
    const c = requireCommitment(commitment);
    const res = await this.env.GROUPS_DB.prepare(
      `UPDATE group_memberships SET revoke_pending = 1
         WHERE country_code = ?1 AND public_commitment = ?2 AND revoked_epoch IS NULL
           AND (?3 IS NULL OR group_id = ?3)`,
    )
      .bind(country, c, group ?? null)
      .run();
    return { revoked: res.meta.changes };
  }

  async publishNow(): Promise<PublishResult[]> {
    return publishAll(this.env);
  }
}

/** Read-only RPC surface for the Anonymous Ballot Worker. */
export class GroupRoots extends WorkerEntrypoint<Env> {
  async accepted(country: string): Promise<AcceptedRoot[]> {
    if (!isCountryCode(country)) return [];
    return acceptedRoots(this.env, country);
  }
}

/** Operational RPC surface for the admin console (aggregate figures only). */
export class GroupOps extends WorkerEntrypoint<Env> {
  async summary(): Promise<unknown> {
    const { results } = await this.env.GROUPS_DB.prepare(
      `SELECT country_code, group_id, epoch, member_count, anonymity_ok, valid_until, superseded_at, revoked_at
         FROM group_root_snapshots ORDER BY epoch DESC LIMIT 40`,
    ).all();
    const pending = await this.env.GROUPS_DB.prepare(
      `SELECT country_code, group_id, COUNT(*) AS n FROM group_memberships WHERE joined_epoch IS NULL GROUP BY 1, 2`,
    ).all();
    return { roots: results, pending: pending.results, minAnonymitySet: minAnonymitySet(this.env) };
  }
  async publishNow(): Promise<PublishResult[]> {
    return publishAll(this.env);
  }
}

async function handlePublic(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET") throw new HttpError("METHOD_NOT_ALLOWED");
  const country = (url.searchParams.get("country") ?? "PH").toUpperCase();
  if (!isCountryCode(country)) throw new HttpError("BAD_REQUEST", "Invalid country.");

  if (url.pathname === "/api/v1/groups/roots") {
    const roots = await acceptedRoots(env, country);
    return json(
      {
        country,
        minAnonymitySet: minAnonymitySet(env),
        verifyKey: JSON.parse(env.ROOT_PUBLIC_KEY),
        roots,
      },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  }

  const m = url.pathname.match(/^\/api\/v1\/groups\/snapshot\/([0-9]{1,78})$/);
  if (m) {
    const group = url.searchParams.get("group") as GroupId | null;
    if (!group || !GROUPS.includes(group)) throw new HttpError("BAD_REQUEST", "Invalid group.");
    const row = await env.GROUPS_DB.prepare(
      `SELECT snapshot_key, snapshot_sha256 FROM group_root_snapshots
         WHERE country_code = ?1 AND group_id = ?2 AND root = ?3 ORDER BY epoch DESC LIMIT 1`,
    )
      .bind(country, group, m[1])
      .first<{ snapshot_key: string; snapshot_sha256: string }>();
    if (!row) throw new HttpError("NOT_FOUND");
    const obj = await env.GROUP_SNAPSHOTS.get(row.snapshot_key);
    if (!obj) throw new HttpError("NOT_FOUND");
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Snapshot-SHA256": row.snapshot_sha256,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  throw new HttpError("NOT_FOUND");
}

export default {
  async fetch(request, env) {
    try {
      return await handlePublic(request, env);
    } catch (err) {
      return errorResponse(err);
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(publishAll(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
