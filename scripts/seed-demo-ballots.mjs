#!/usr/bin/env node
/**
 * LOCAL DEVELOPMENT ONLY. Inserts synthetic COUNTED ballots (tagged root_epoch = -1) so the homepage
 * and rankings can be previewed with data, then rebuilds aggregates. `--clear` removes them again.
 * Requires `npm run dev`. The endpoint exists only behind the local dev gateway.
 */
const base = process.env.GOVZONES_DEV_URL ?? "http://govzones.localhost:5173";
const action = process.argv.includes("--clear") ? "clear" : "seed";
const res = await fetch(`${base}/__dev/demo-ballots`, { method: "POST", body: JSON.stringify({ action }) });
console.log(action === "clear" ? "Removed synthetic demo ballots:" : "Seeded synthetic demo ballots (local only):", JSON.stringify(await res.json()));
