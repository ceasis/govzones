# GovZones

**Government offices, rated by the people.** An independent, mobile-first platform where people search Philippine government agencies and offices and give one whole-number rating from 1 to 10. Ballots are anonymous: each one is a **Semaphore v4 zero-knowledge group-membership proof**, sent to a separate cookie-free ballot service ("Option B").

The authoritative product requirements are in [`government-agency-ranking-specs (1).md`](./government-agency-ranking-specs%20(1).md). This README covers how the implementation maps to that spec, how to run and test it, and what still stands between this code and a public launch.

> **Status:** feature-complete MVP, verified locally (unit tests, end-to-end ballot tests, browser journey and 320–430 px layout checks). A **temporary workers.dev preview** is live for demos (test sign-in, test data; see [Temporary preview](#temporary-preview-workersdev)); staging and production are not deployed. Launch gates that cannot be met in code alone are listed under [Launch gates](#launch-gates-not-done--require-people-or-accounts).

---

## Architecture: six Workers, four trust boundaries

```
 Browser (wallet: Semaphore identity + own rating list, encrypted locally; proofs made in a Web Worker)
   │                         │                                   │
   │ public pages/API        │ sign-in + public commitment       │ ZK proof only — no cookies,
   ▼                         ▼                                   ▼ no login, no Referer
 web  (govzones.com)      accounts (accounts.govzones.com)     ballot (vote.govzones.com)
   │ D1 directory (RO)      │ D1 identity  R2 wallet ciphertext   │ D1 votes_ph_00  Durable Object per entity
   │ KV rankings            │ ──RPC GroupMembership──┐            │ ──RPC GroupRoots (signed roots)──┐
   │ ──fetch──▶ groups ◀────┘                        ▼            │ ──Queue──▶ aggregator            │
   │            (D1 groups, R2 snapshots,  signed batched Merkle roots)  │ (COUNTED-only totals → D1 directory + KV)
   └────────────────────────────────────────────────────────────────────┘
 admin (admin.govzones.com, Cloudflare Access): directory D1 + narrow RPC entrypoints only
```

| Worker | Directory | Holds | Never holds |
| --- | --- | --- | --- |
| **web** | `workers/web`, `app/` | SSR site, public `/api/v1`, directory search (FTS5) | identity DB, votes DB |
| **accounts** | `workers/accounts` | e-mail one-time-code sign-in (Cloudflare Email Sending), host-only sessions, CSRF, enrollment of **public commitments**, ciphertext-only backups, suggestions | votes DB, e-mail addresses (only a keyed hash), entity being rated, nullifiers, scores |
| **groups** | `workers/groups` | Submit and Countable groups, batched shuffled epochs, ECDSA-signed roots, public snapshots | account IDs, ballots |
| **ballot** | `workers/ballot` | proof verification, challenges, one ballot per `(entity, nullifier)`, receipts, appeals | identity DB, sessions, sign-in secrets; observability disabled |
| **aggregator** | `workers/aggregator` | stage-2 screening, 24 h maturation, recompute from `COUNTED` rows, ranking snapshots | identity DB |
| **admin** | `workers/admin` | curation and moderation consoles behind Cloudflare Access | votes and identity DBs (reaches them only through RPC entrypoints) |

**Why the verifier isn't snarkjs.** snarkjs compiles WebAssembly at runtime and calls `URL.createObjectURL`. Workers allow neither, which I confirmed in a spike. `shared/zk/verify.ts` therefore implements the Groth16 check on the audited [`@noble/curves`](https://github.com/paulmillr/noble-curves) BN254 pairing, using the **exact** verification keys shipped with `@semaphore-protocol/proof@4.14.5`:
- the vendored keys are tested byte-for-byte against that package;
- the verifier is cross-checked against snarkjs on real proofs, both valid and tampered;
- verification takes about 20 ms in workerd.

No custom circuit is used.

## Quick start (local)

Requirements: Node ≥ 22 (tested on 26), Google Chrome for the browser tests.

```bash
npm install
npm run setup          # dev keys (.dev.vars), pinned ZK artifacts (hash-locked), local D1 migrations + seed
npm run dev            # all six Workers in one local workerd via the Vite plugin
```

| Host | What |
| --- | --- |
| http://govzones.localhost:5173/ph | public site |
| http://accounts.govzones.localhost:5173 | accounts (sign-in codes are returned by the API instead of e-mailed: `DEV_EMAIL_CODES=1`) |
| http://vote.govzones.localhost:5173 | anonymous ballot API |
| http://admin.govzones.localhost:5173 | admin console (local role bypass; refused on any non-localhost host) |

Chrome and Firefox resolve `*.localhost` to your machine automatically. The web Worker's **dev gateway** routes each host to its Worker. It exists only in the local config, never in `env.staging` or `env.production`.

Local-only helpers. The endpoints behind them exist only behind the dev gateway or behind `DEV_TOOLS=1`.

```bash
npm run demo:tick      # stands in for the cron triggers (root publication, trust screening, maturation, rankings)
npm run demo:ballots   # synthetic COUNTED ballots so rankings are populated (tagged; `npm run demo:clear` removes them)
npm run db:reset:local # wipe local state and re-apply migrations
```

The local config deliberately relaxes a few things so you can try the flow alone:
- sign-in codes are shown on the sign-in page instead of being e-mailed;
- epochs publish immediately after enrollment;
- the Countable Group maturity wait is 0 h;
- the minimum anonymity set is 2.

These are top-level (local) settings. The deploy guard refuses on-page sign-in codes, instant epochs and an anonymity set below 100 for staging and production; the temporary preview may use the last two but always e-mails real codes.

## Tests

```bash
npm test               # 38 unit tests: verifier vs snarkjs, protocol, scoring, signing, wallet crypto, e-mail sign-in, admin access, ballot/aggregate logic on real SQLite
npm run e2e:ballot     # 50 end-to-end checks against the running local stack with real Semaphore proofs
npm run e2e:browser    # browser journey at 375 px: rate → sign in → wallet + recovery key → enroll → in-browser proof → My ratings
npm run e2e:layout     # 23 pages × 320/360/375/390/414/430 px: asserts scrollWidth <= innerWidth (+ screenshots in test-results/)
npm run typecheck
```

`e2e:ballot` needs `npm run dev` (it drives local-only dev endpoints). `e2e:browser` and `e2e:layout` take a base URL as their first argument, so they can also check the temporary preview, e.g. `npm run e2e:browser -- https://govzones-web-preview.qnsub.workers.dev`. Never point any of them at staging or production.

## Acceptance checklist (spec §14)

Legend: ✅ verified by automated tests here · 🟡 implemented, needs the named external check · ⛔ needs people, accounts or devices.

| ID | Status | Evidence / what remains |
| --- | --- | --- |
| AC-01 | ✅ | All public pages and the API work signed out (layout and smoke runs) |
| AC-02 | ✅ | e2e §3 covers invalid, replayed, fabricated and wrong-scope proofs, unapproved roots, scores 0/11/8.5/"8", unknown entity, cookie, Authorization and Referer |
| AC-03 | ✅ | e2e §4 and unit tests: concurrent proofs produce exactly one row (unique index + revision guard + per-entity Durable Object) |
| AC-04 | ✅ | e2e §7–8: update replaces without adding, cooldown enforced server-side, DELETE proof, no delete→re-rate bypass |
| AC-05 | 🟡 | e2e §12: deletion revokes membership. UX offers "delete ratings first". Legal notice review pending |
| AC-06 | 🟡 | Schemas and bindings contain no join key, and the ballot Worker has observability off. Needs a Cloudflare-side log review once deployed |
| AC-07 | ⚠️ | Floor lowered from 30 to 1 at the owner's request (see deviations); unit test and e2e §11 check the new floor |
| AC-08 | ✅ | Unit test: duplicate and stale recomputes cannot double-count or roll back |
| AC-09 | ✅ | Ranking cards show rank, score, count, geography, period and a methodology link |
| AC-10 | 🟡 | Automated in headless Chrome at all six widths. Real iOS Safari / Android Chrome tap and swipe tests remain ⛔ |
| AC-11 | 🟡 | Semantic markup, labelled controls, 44 px targets, focus styles, reduced motion. Needs a screen-reader and keyboard audit ⛔ |
| AC-12 | 🟡 | Admin requires a Cloudflare Access JWT plus a role; there is no public admin route. Configure the Access app ⛔ |
| AC-13 | ✅ | Directory, moderation and enrollment audit trails. No staff path writes scores |
| AC-14 | ⛔ | Restore, load, bot-attack tests and privacy notice review |
| AC-15 | ✅ | e2e §5–6 and unit test: a Submit-only proof is stored, acknowledged identically, and never counted |
| AC-16 | ✅ | e2e §10 and unit test |
| AC-17 | 🟡 | No account field exists in the votes DB and no ballot field in the identity DB, by construction. Needs an independent reviewer ⛔ |
| AC-18 | ✅ | e2e §4 and unit tests: per-entity nullifiers differ; the same entity keeps the same nullifier |
| AC-19 | 🟡 | Browser proving runs off the main thread (1.3 s on desktop with artifacts cached). Mid-range Android devices still to be measured ⛔ |
| AC-20 | ✅ | Ballots from roots below the anonymity threshold never mature. Revocation immediately invalidates earlier roots (e2e §12) |
| AC-21 | ✅ | Enrollment screening (accounts Worker) has no access to agencies or scores; ballot screening (aggregator) has no access to accounts |
| AC-22 | 🟡 | No backend path can derive nullifiers. Disclosed in the UI, `/about` and `/privacy`. Demonstration with a reviewer ⛔ |

## Temporary preview (workers.dev)

A throwaway demo deployment, separate from staging and production:

| URL | Worker |
| --- | --- |
| https://govzones-web-preview.qnsub.workers.dev/ph | web |
| https://govzones-accounts-preview.qnsub.workers.dev | accounts (sign-in codes are e-mailed from `signin@qnsub.com`) |
| https://govzones-ballot-ph-00-preview.qnsub.workers.dev | anonymous ballot API |

groups and aggregator have no public URL. There is no admin Worker, because no Cloudflare Access application protects workers.dev.

The preview is for demos, not real ratings:
- anyone with the link and an e-mail address can create an account; there is no Turnstile;
- epochs publish immediately, the Countable maturity wait is 0 h and the minimum anonymity set is 2;
- every page shows a "Temporary preview" banner; `robots.txt` disallows everything and pages send `noindex`.

`workers.dev` is on the Public Suffix List, so the three hosts are separate origins of one site, just as `govzones.com` and its subdomains will be. Host-only session cookies reach the accounts Worker and never the ballot Worker; the browser journey checks this.

- **Redeploy** after code changes: `npm run preview:deploy`. The `*-preview` D1, KV, R2 and queue IDs are in each `env.preview` block. Secrets (`ROOT_SIGNING_KEY` on groups; `SUBJECT_PEPPER` on accounts) were set once with `wrangler secret bulk` and persist across deploys. Sign-in e-mails go out through the account's Cloudflare Email Sending domain `qnsub.com`.
- **Remove everything:** `npm run preview:destroy -- --yes` (try `-- --dry-run` first). It deletes the five Workers, the queue, the R2 objects and buckets, the four D1 databases and the KV namespace, every name taken from the `env.preview` blocks.

## Deployment (Cloudflare)

1. **Create resources** for each environment (staging names end in `-staging`):
   - D1 databases: `govzones-directory`, `govzones-identity`, `govzones-groups`, `govzones-votes-ph-00`
   - KV: public cache
   - R2: `govzones-group-snapshots`, `govzones-wallet-backups`
   - Queue: `govzones-aggregate-ph`

   Put the IDs into each `env.production` block (`REPLACE_WITH_*`).
2. **Root signing key:** `node scripts/generate-dev-keys.mjs --print`.
   - Put the private JWK in a secret: `wrangler secret put ROOT_SIGNING_KEY -c workers/groups/wrangler.jsonc --env production`.
   - Put the public JWK into `ROOT_PUBLIC_KEY` in the web, groups and ballot configs.
3. **Accounts:** secrets `SUBJECT_PEPPER` and `TURNSTILE_SECRET` (the Turnstile site key is a var). Sign-in is by e-mailed one-time code: enable Cloudflare Email Sending on `govzones.com` (`wrangler email sending enable govzones.com`, then add the DNS records it asks for) and keep `EMAIL_FROM` (`signin@govzones.com`) on that domain. Only a keyed hash of each address is stored.
4. **Cloudflare Access:** protect `admin.govzones.com` (require MFA). Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ADMIN_ROLES` (e-mail → `curator` / `moderator` / `sysadmin`).
5. **ZK artifacts** are served from `public/zk/` as static assets. Run `npm run zk:fetch -- --depths 16-20` before building. The SHA-256 lock in `shared/zk/artifacts-lock.json` is compiled into the client, which refuses mismatched files.
6. `node scripts/deploy.mjs --env staging --dry-run`, then for real. The script refuses to run while any placeholder or dev-only flag remains. It applies remote migrations, deploys groups → accounts → ballot → aggregator → admin, then builds and deploys web.
7. DNS: GovZones.com is not configured yet. The Worker routes use custom domains (`govzones.com`, `accounts.`, `vote.`, `admin.`).

## Deliberate deviations and decisions (please review)

- **Receipt lookup is `POST /anonymous/v1/receipts/lookup`, not `GET /receipts/:id`.** Spec §11 forbids ballot receipts in URLs and logs, which overrides the §9 table. Status lookups by nullifier are also POST-only.
- **Rating before sign-in:** the chosen score and page are kept in `sessionStorage`. Sign-in returns to a generic `/me/wallet` URL, so the account host never learns which agency you were rating. The first ballot is then queued with a random 8–40 s delay, so it doesn't arrive in the same moment as the login.
- **Trust upgrades:** a same-score re-proof promotes a Submit-only ballot to Countable. It happens automatically, but at randomised times spread over 6–72 h, so that one wallet's ballots are not all promoted together (which would link them).
- **Deleted accounts / approved wallet resets** can enroll again, but stay Submit-only for 365 days, because earlier anonymous ballots cannot be found. This needs privacy-law review (spec §2.4, §11).
- **Display thresholds were lowered to 1 on 2026-11-01 at the owner's request** (spec §6 and AC-07 said 30 for rankings, 5 for profile averages, 10 for histograms). Averages, distributions and Best/Lowest rankings now appear from the first eligible rating and small-number suppression is off. The Bayesian prior (m = 20) still holds thinly rated listings near their cohort average, so one 10 cannot top a list. All constants are in `SCORING` (`shared/scoring.ts`); methodology version `2026.11-v2`. Raising them again is a one-line change per constant, and the copy adapts.
- **Proof depth** has a floor of 16, so clients need only a few pinned artifacts (about 5 MB each, cached after first use).
- **Directory seed:** 5,405 listings in two batches and 247 geographic units. Batch 1 (`data/ph/directory.json` → migration 0002): 86 national agencies, 22 GOCCs, 229 LGUs, 26 field offices, 60 LGU offices. Batch 2 (`data/ph/offices.json` → migration 0003, generated by `scripts/generate-ph-offices.mjs`): 4,982 offices throughout the country — regional offices of ~27 agencies in every region, PSA/DepEd/PNP/DTI/TESDA/DAR/COMELEC/Registry of Deeds/DOLE/DPWH/DENR offices and the nine standard provincial-government offices in every province, the ten standard local-government offices plus police, fire, post office, election officer, schools division and LTO in every city and municipality, SSS/Pag-IBIG/PhilHealth/GSIS branches in larger cities, and named lists (BIR revenue regions and districts, DFA consular offices, BOC ports, NBI and PRC regional offices, BI, SEC, Ombudsman) and the 16 Bangsamoro Government ministries. Structural entries are what the law or standing practice says every unit has; they were not individually checked. Everything is compiled from public knowledge and marked **"pending source verification"**; each entry's `reviewNote` says what a curator must confirm. Curator notes for uncertain items (e.g. Sulu's move to Region IX, pending HUC plebiscites) are in the admin entity history. PSGC codes are blank: importing the official PSA PSGC file and verifying the seed against the DBM 2026 directory are curator tasks (spec §4).

## Launch gates (not done — require people or accounts)

From spec §2.1, §7, §11 and §15. None of these can honestly be completed in code alone:

1. Independent cryptographic audit, especially of `shared/zk/verify.ts`, scope and nullifier derivation, root signing and root acceptance policy.
2. Benchmark Workers proof verification under load (CPU time and p95), plus proving on mid-range Philippine-market Android devices.
3. Philippine Data Privacy Act review: the privacy notice (currently a draft), retention after account deletion, and the "cannot locate old ballots" limitation.
4. Email Sending enabled on govzones.com, Turnstile keys and a Cloudflare Access application.
5. Curator verification of the directory seed against official sources, and the PSGC import.
6. Restore drills, load tests, bot-attack tests, real-device iOS/Android QA, and a screen-reader audit.
7. Operations: incident runbook, on-call, and appeal reviewer staffing.

## Scaling notes

- **Votes are sharded.** The shard key is country + entity, with one D1 database per vote shard (`votes_ph_00` initially). New shards are new Workers and bindings; nothing switches databases dynamically.
- **Group roots are fully rebuilt each epoch.** The Group Manager recomputes the whole Merkle tree, and the snapshot is a JSON leaf list stored in R2. That's fine well into six figures of members; beyond that, switch to incremental tree state and compressed snapshots (spec §12).
- **Hot entities are serialised** through a per-entity Durable Object. Public reads come from KV snapshots and the derived `entity_public_stats`; they never hit the votes DB.

## Repository layout

```
app/                React Router (SSR) public site; app/wallet = client wallet, prover worker, clients
workers/            web (entry, API, dev gateway) · accounts · groups · ballot · aggregator · admin
shared/             protocol (scope/message/nullifier), zk verifier + pinned keys, signing, scoring, directory vocab
migrations/         D1 schemas per database (+ generated PH seed)
data/ph/            directory seed source (JSON) → scripts/build-directory-seed.mjs
scripts/            setup, artifact fetch/lock, local migrations, demo data, e2e + layout tests, guarded deploy, preview teardown
tests/              vitest unit tests (real SQLite via node:sqlite for D1 logic)
```
