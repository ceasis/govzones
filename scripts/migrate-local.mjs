#!/usr/bin/env node
/** Applies all D1 migrations to the shared local state used by `npm run dev`. */
import { execFileSync } from "node:child_process";

const dbs = [
  ["govzones-directory", "wrangler.jsonc"],
  ["govzones-identity", "workers/accounts/wrangler.jsonc"],
  ["govzones-groups", "workers/groups/wrangler.jsonc"],
  ["govzones-votes-ph-00", "workers/ballot/wrangler.jsonc"],
];
for (const [name, config] of dbs) {
  console.log(`\n→ ${name}`);
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", name, "--local", "--persist-to", ".wrangler/state", "-c", config], {
    stdio: "inherit",
    env: { ...process.env, CI: "1" },
  });
}
