#!/usr/bin/env node
/**
 * Guarded deployment of every GovZones Worker to Cloudflare.
 *
 *   node scripts/deploy.mjs --env staging|production|preview [--dry-run] [--skip-migrations]
 *
 * Refuses to run while any REPLACE_WITH_* placeholder remains in the chosen environment's
 * configuration, or while dev-only flags would be deployed. Order: D1 migrations → groups →
 * accounts → ballot → aggregator → admin → web (Vite build). Requires `wrangler login` (or
 * CLOUDFLARE_API_TOKEN) and the secrets listed in README.md.
 *
 * `preview` is the temporary workers.dev demo: it may use instant root publication and a tiny
 * anonymity set, but only on workers.dev (no routes / custom domains), and has no admin Worker
 * (there is no Cloudflare Access application in front of it). Remove it with preview-destroy.mjs.
 */
import { execFileSync } from "node:child_process";
import { readJsonc } from "./jsonc.mjs";

const args = process.argv.slice(2);
const env = args[args.indexOf("--env") + 1];
const dryRun = args.includes("--dry-run");
const skipMigrations = args.includes("--skip-migrations");
if (!["staging", "production", "preview"].includes(env)) {
  console.error("Usage: node scripts/deploy.mjs --env staging|production|preview [--dry-run] [--skip-migrations]");
  process.exit(2);
}
const preview = env === "preview";

const WORKERS = [
  { name: "groups", config: "workers/groups/wrangler.jsonc", db: ["govzones-groups"] },
  { name: "accounts", config: "workers/accounts/wrangler.jsonc", db: ["govzones-identity"] },
  { name: "ballot", config: "workers/ballot/wrangler.jsonc", db: ["govzones-votes-ph-00"] },
  { name: "aggregator", config: "workers/aggregator/wrangler.jsonc", db: [] },
  { name: "admin", config: "workers/admin/wrangler.jsonc", db: [], skipPreview: true },
  { name: "web", config: "wrangler.jsonc", db: ["govzones-directory"] },
].filter((w) => !(preview && w.skipPreview));
const DEV_ONLY_VARS = ["DEV_EMAIL_CODES", "DEV_INSTANT_EPOCH", "DEV_GATEWAY", "DEV_TOOLS", "ADMIN_DEV_BYPASS"];
// Instant epochs are tolerated on the workers.dev preview only. Sign-in codes are always sent by e-mail there.
const PREVIEW_ALLOWED = ["DEV_INSTANT_EPOCH"];

const problems = [];
for (const w of WORKERS) {
  const section = readJsonc(w.config).env?.[env];
  if (!section) {
    problems.push(`${w.config}: no env.${env} section`);
    continue;
  }
  const text = JSON.stringify(section);
  for (const m of text.matchAll(/REPLACE_WITH_[A-Z0-9_]+/g)) problems.push(`${w.config} env.${env}: placeholder ${m[0]}`);
  for (const v of DEV_ONLY_VARS) {
    if (!section.vars || !(v in section.vars) || (preview && PREVIEW_ALLOWED.includes(v))) continue;
    problems.push(`${w.config} env.${env}: dev-only var ${v} must not be deployed`);
  }
  if (preview && (section.routes || section.route)) problems.push(`${w.config}: the preview must stay on workers.dev (no routes or custom domains)`);
  if (!preview && w.name === "groups" && Number(section.vars?.MIN_ANONYMITY_SET ?? 0) < 100) problems.push(`${w.config}: MIN_ANONYMITY_SET below the 100-member design target`);
  if (w.name === "ballot" && section.observability?.enabled) problems.push(`${w.config}: ballot Worker must not enable observability logs`);
}
if (problems.length) {
  console.error(`Refusing to deploy ${env}:\n  - ${[...new Set(problems)].join("\n  - ")}`);
  process.exit(1);
}

const sh = (cmd, cmdArgs, extraEnv = {}) => {
  console.log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  if (!dryRun) execFileSync(cmd, cmdArgs, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
};

if (!skipMigrations) {
  for (const w of WORKERS) {
    for (const db of w.db) {
      const name = env === "production" ? db : `${db}-${env}`;
      sh("npx", ["wrangler", "d1", "migrations", "apply", name, "--remote", "-c", w.config, "--env", env]);
    }
  }
}
for (const w of WORKERS.filter((x) => x.name !== "web")) sh("npx", ["wrangler", "deploy", "-c", w.config, "--env", env]);
sh("npx", ["react-router", "build"], { CLOUDFLARE_ENV: env });
sh("npx", ["wrangler", "deploy"]);
console.log(dryRun ? "\nDry run complete (nothing deployed)." : `\nDeployed GovZones (${env}).`);
