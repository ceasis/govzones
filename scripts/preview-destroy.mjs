#!/usr/bin/env node
/**
 * Tears down the temporary workers.dev preview created by `deploy.mjs --env preview`: its Workers
 * (and their Durable Object storage and secrets), the aggregate queue, the R2 objects and buckets,
 * the preview D1 databases and the public-cache KV namespace. Irreversible, so it requires --yes.
 *
 *   node scripts/preview-destroy.mjs --yes [--dry-run]
 *
 * Every resource name and ID is read from the env.preview sections, so nothing outside the preview
 * can be touched. R2 buckets must be empty before deletion; every object the app writes is recorded
 * in D1 (group_root_snapshots.snapshot_key, encrypted_wallet_backups.ciphertext_object_key), so
 * those keys are read first and the objects deleted one by one.
 */
import { execFileSync } from "node:child_process";
import { readJsonc } from "./jsonc.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
if (!args.includes("--yes") && !dryRun) {
  console.error("Deletes the whole temporary preview. Usage: node scripts/preview-destroy.mjs --yes [--dry-run]");
  process.exit(2);
}

// Dependents first, so no service binding points at an already-deleted Worker.
const CONFIGS = ["wrangler.jsonc", "workers/aggregator/wrangler.jsonc", "workers/ballot/wrangler.jsonc", "workers/accounts/wrangler.jsonc", "workers/groups/wrangler.jsonc"];
const sections = CONFIGS.map((config) => {
  const section = readJsonc(config).env?.preview;
  if (!section?.name?.endsWith("-preview")) throw new Error(`${config}: env.preview missing or not named *-preview`);
  return { config, section };
});
const unique = (xs) => [...new Set(xs)];
const d1 = unique(sections.flatMap(({ section }) => (section.d1_databases ?? []).map((d) => d.database_name)));
const kv = unique(sections.flatMap(({ section }) => (section.kv_namespaces ?? []).map((k) => k.id)));
const buckets = unique(sections.flatMap(({ section }) => (section.r2_buckets ?? []).map((b) => b.bucket_name)));
const queues = unique(sections.flatMap(({ section }) => [...(section.queues?.producers ?? []), ...(section.queues?.consumers ?? [])].map((q) => q.queue)));
for (const name of [...d1, ...buckets, ...queues]) if (!name.endsWith("-preview")) throw new Error(`refusing to delete non-preview resource ${name}`);

const failures = [];
function wrangler(cmdArgs, { capture = false } = {}) {
  console.log(`$ npx wrangler ${cmdArgs.join(" ")}`);
  if (dryRun && !capture) return "";
  try {
    return execFileSync("npx", ["wrangler", ...cmdArgs], { stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8" });
  } catch {
    failures.push(cmdArgs.slice(0, 3).join(" "));
    return null;
  }
}

/** Object keys recorded in a preview D1 table (read-only query; also runs in --dry-run). */
function recordedKeys(config, db, sql) {
  const out = wrangler(["d1", "execute", db, "--remote", "--json", "-c", config, "--env", "preview", "--command", sql], { capture: true });
  if (!out) return [];
  return JSON.parse(out).flatMap((r) => (r.results ?? []).map((row) => row.k));
}
const objects = {
  "govzones-group-snapshots-preview": recordedKeys("workers/groups/wrangler.jsonc", "govzones-groups-preview", "SELECT snapshot_key AS k FROM group_root_snapshots"),
  "govzones-wallet-backups-preview": recordedKeys("workers/accounts/wrangler.jsonc", "govzones-identity-preview", "SELECT ciphertext_object_key AS k FROM encrypted_wallet_backups"),
};

for (const { config } of sections) wrangler(["delete", "-c", config, "--env", "preview", "--force"]);
for (const q of queues) wrangler(["queues", "delete", q]);
for (const bucket of buckets) {
  for (const key of objects[bucket] ?? []) wrangler(["r2", "object", "delete", `${bucket}/${key}`, "--remote"]);
  wrangler(["r2", "bucket", "delete", bucket]);
}
for (const name of d1) wrangler(["d1", "delete", name, "-y"]);
for (const id of kv) wrangler(["kv", "namespace", "delete", "--namespace-id", id, "-y"]);

if (failures.length) {
  console.error(`\nSome steps failed (already deleted, or a bucket still holds unrecorded objects):\n  - ${failures.join("\n  - ")}`);
  console.error("Re-run, or remove what is left in the Cloudflare dashboard.");
  process.exit(1);
}
console.log(
  dryRun
    ? "\nDry run complete (nothing deleted)."
    : "\nPreview removed. The env.preview sections now reference deleted resources: delete them, or create new resources and update the IDs before the next preview deploy.",
);
