#!/usr/bin/env node
/**
 * LOCAL DEVELOPMENT ONLY. Stands in for the production cron triggers: publishes group epochs,
 * runs enrollment trust screening, then ballot screening, maturation and ranking snapshots.
 */
const base = process.env.GOVZONES_DEV_URL ?? "http://govzones.localhost:5173";
const res = await fetch(`${base}/__dev/tick`, { method: "POST" });
console.log(JSON.stringify(await res.json(), null, 2));
