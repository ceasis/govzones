#!/usr/bin/env node
/**
 * Generates LOCAL DEVELOPMENT secrets into .dev.vars files (gitignored):
 *  - group-root signing keypair (ECDSA P-256 JWK) for the Group Manager, public key for verifiers
 *  - subject pepper for the Account Worker
 * Existing files are kept unless --force is passed. Production secrets are set with `wrangler secret put`.
 *
 * `--print` writes nothing and prints a fresh production root keypair instead:
 *   private JWK → `wrangler secret put ROOT_SIGNING_KEY -c workers/groups/wrangler.jsonc --env production`
 *   public JWK  → ROOT_PUBLIC_KEY var in the web, groups and ballot configs.
 */
import { existsSync, writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const force = process.argv.includes("--force");
const rand = (n = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
const pubJson = JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y });
const privJson = JSON.stringify({ kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d });

if (process.argv.includes("--print")) {
  console.log("ROOT_SIGNING_KEY (secret, groups Worker only):\n" + privJson + "\n");
  console.log("ROOT_PUBLIC_KEY (public var for web, groups, ballot):\n" + pubJson);
  process.exit(0);
}

const files = {
  ".dev.vars": `ROOT_PUBLIC_KEY='${pubJson}'\n`,
  "workers/groups/.dev.vars": `ROOT_SIGNING_KEY='${privJson}'\nROOT_PUBLIC_KEY='${pubJson}'\n`,
  "workers/ballot/.dev.vars": `ROOT_PUBLIC_KEY='${pubJson}'\n`,
  "workers/accounts/.dev.vars": `SUBJECT_PEPPER='${rand()}'\n# TURNSTILE_SECRET=''\n`,
};

const anyExisting = Object.keys(files).some((f) => existsSync(f));
if (anyExisting && !force) {
  console.log("dev keys: .dev.vars files already exist (use --force to regenerate all of them together)");
  process.exit(0);
}
for (const [file, body] of Object.entries(files)) writeFileSync(file, body, { mode: 0o600 });
console.log("dev keys: wrote", Object.keys(files).join(", "));
