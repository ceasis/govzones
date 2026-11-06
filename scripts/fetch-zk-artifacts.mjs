#!/usr/bin/env node
/**
 * Downloads the pinned Semaphore proving artifacts (wasm + zkey) and self-hosts them under
 * public/zk/semaphore/<version>/, so the browser never contacts a third-party CDN while voting.
 *
 * shared/zk/artifacts-lock.json records the SHA-256 of every file and is compiled into the
 * client bundle; the prover refuses any artifact whose hash differs. The lock is committed:
 * if a download ever differs from the lock, this script fails loudly.
 *
 * Usage: node scripts/fetch-zk-artifacts.mjs [--depths 16-20]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "4.13.0";
const BASE = `https://snark-artifacts.pse.dev/semaphore/${VERSION}`;
const lockPath = join(root, "shared/zk/artifacts-lock.json");
const outDir = join(root, "public/zk/semaphore", VERSION);

const arg = process.argv.indexOf("--depths");
const [lo, hi] = (arg > 0 ? process.argv[arg + 1] : "16-20").split("-").map(Number);
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : { version: VERSION, files: {} };
if (lock.version !== VERSION) throw new Error(`lock is for ${lock.version}, expected ${VERSION}`);
mkdirSync(outDir, { recursive: true });

for (let d = lo; d <= (hi || lo); d++) {
  for (const ext of ["wasm", "zkey"]) {
    const name = `semaphore-${d}.${ext}`;
    const path = join(outDir, name);
    let bytes;
    if (existsSync(path)) {
      bytes = readFileSync(path);
    } else {
      const res = await fetch(`${BASE}/${name}`);
      if (!res.ok) throw new Error(`download failed: ${name} (${res.status})`);
      bytes = Buffer.from(await res.arrayBuffer());
    }
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (lock.files[name] && lock.files[name] !== sha) {
      throw new Error(`HASH MISMATCH for ${name}: lock ${lock.files[name]} vs downloaded ${sha}. Refusing to continue.`);
    }
    lock.files[name] = sha;
    writeFileSync(path, bytes);
    console.log(`${name}  ${sha}  ${(bytes.length / 1e6).toFixed(1)} MB`);
  }
}
lock.files = Object.fromEntries(Object.entries(lock.files).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })));
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
