#!/usr/bin/env node
/**
 * End-to-end anonymous ballot test against the LOCAL dev stack (`npm run dev`).
 * Uses real Semaphore v4 proofs (generated in Node with the pinned artifacts) and covers
 * AC-02/03/04/06/07/15/16/18/20 behaviours. Never point this at a deployed environment.
 */
import { Identity, Group, generateProof } from "@semaphore-protocol/core";
import { webcrypto } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ballotMessage, entityScope } from "../shared/protocol.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = "http://govzones.localhost:5173";
const ACC = "http://accounts.govzones.localhost:5173";
const VOTE = "http://vote.govzones.localhost:5173";
const ADMIN = "http://admin.govzones.localhost:5173";
const run = Date.now().toString(36);

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

class Jar {
  map = new Map();
  absorb(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [k, v] = pair.split("=");
      if (attrs.some((a) => /max-age=0/i.test(a))) this.map.delete(k.trim());
      else this.map.set(k.trim(), v);
    }
  }
  get header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function json(res) {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

async function signIn(who) {
  const jar = new Jar();
  const email = `${who}@example.test`;
  const start = await json(await fetch(`${ACC}/api/v1/auth/email/start`, { method: "POST", headers: { origin: WEB, "content-type": "application/json" }, body: JSON.stringify({ email }) }));
  if (!start.body.devCode) throw new Error("local accounts Worker did not return a dev sign-in code: " + JSON.stringify(start.body));
  const r = await fetch(`${ACC}/api/v1/auth/email/verify`, {
    method: "POST",
    headers: { origin: WEB, "content-type": "application/json" },
    body: JSON.stringify({ email, code: start.body.devCode }),
  });
  if (r.status !== 200) throw new Error("e-mail code verify failed: " + (await r.text()));
  jar.absorb(r);
  const s = await json(await fetch(`${ACC}/api/v1/session`, { headers: { cookie: jar.header, origin: WEB } }));
  return { jar, csrf: s.body.csrfToken, session: s.body };
}

async function acc(user, path, method, body) {
  return json(
    await fetch(`${ACC}${path}`, {
      method,
      headers: { cookie: user.jar.header, origin: WEB, "x-csrf-token": user.csrf, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

async function vote(path, method, body, extraHeaders = {}) {
  return json(await fetch(`${VOTE}${path}`, { method, headers: { "content-type": "application/json", origin: WEB, ...extraHeaders }, body: JSON.stringify(body) }));
}

const tick = async () => json(await fetch(`${WEB}/__dev/tick`, { method: "POST" }));
const age = (hours, lastScored = false) => fetch(`${WEB}/__dev/age`, { method: "POST", body: JSON.stringify({ hours, lastScored }) }).then((r) => r.json());
const ballots = (entityId) => fetch(`${WEB}/__dev/ballots?entity=${entityId}`).then((r) => r.json());

async function verifiedRoots() {
  const { body } = await json(await fetch(`${WEB}/api/v1/groups/roots?country=PH`));
  const key = await webcrypto.subtle.importKey("jwk", { ...body.verifyKey, key_ops: ["verify"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const out = [];
  for (const r of body.roots) {
    const sig = Buffer.from(r.signature, "base64url");
    if (await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(r.payload))) out.push({ ...r.record, snapshotPath: r.snapshotPath });
  }
  return out;
}

async function membership(identity, preferGroup) {
  const roots = (await verifiedRoots()).sort((a, b) => b.epoch - a.epoch);
  for (const r of roots.filter((x) => !preferGroup || x.group === preferGroup)) {
    const snap = await (await fetch(`${WEB}${r.snapshotPath}`)).json();
    if (snap.leaves.includes(identity.commitment.toString())) return { root: r, leaves: snap.leaves };
  }
  return null;
}

const artifacts = (d) => ({
  wasm: join(root, `public/zk/semaphore/4.13.0/semaphore-${d}.wasm`),
  zkey: join(root, `public/zk/semaphore/4.13.0/semaphore-${d}.zkey`),
});

async function makeBallot(identity, entityId, operation, score, { group, entityForScope } = {}) {
  const m = await membership(identity, group);
  if (!m) throw new Error("not a member");
  const ch = await vote("/anonymous/v1/challenges", "POST", { entityId, operation });
  if (ch.status !== 200) throw new Error("challenge failed " + JSON.stringify(ch.body));
  const challenge = ch.body.challenge;
  const scope = entityScope("PH", entityForScope ?? entityId);
  const message = ballotMessage({ operation, entityId, score: operation === "UPSERT" ? score : null, challenge });
  const g = new Group(m.leaves.map(BigInt));
  const proof = await generateProof(identity, g, message, scope, m.root.proofDepth, artifacts(m.root.proofDepth));
  return {
    entityId,
    operation,
    ...(operation === "UPSERT" ? { score } : {}),
    scope: proof.scope,
    nullifier: proof.nullifier,
    groupRoot: proof.merkleTreeRoot,
    challenge,
    proof,
    _group: m.root.group,
  };
}

const put = (b) => vote(`/anonymous/v1/ballots/${b.entityId}`, "PUT", strip(b));
const del = (b) => vote(`/anonymous/v1/ballots/${b.entityId}`, "DELETE", strip(b));
const strip = ({ _group, ...b }) => b;

async function entityId(q) {
  const { body } = await json(await fetch(`${WEB}/api/v1/entities?q=${encodeURIComponent(q)}&limit=1`));
  return body.items[0].id;
}
const score = async (id) => (await json(await fetch(`${WEB}/api/v1/entities/${id}/score?period=12m`))).body;

console.log(`GovZones e2e (run ${run})`);

console.log("\n1. Enrollment (account host) — public commitments only");
const users = [];
for (let i = 0; i < 3; i++) {
  const u = await signIn(`e2e-${run}-${i}`);
  u.identity = new Identity();
  const r = await acc(u, "/api/v1/wallet/enroll", "POST", { country: "PH", commitment: u.identity.commitment.toString() });
  check(`user ${i} enrolled`, r.status === 200 && r.body.status === "enrolled", JSON.stringify(r.body));
  users.push(u);
}
const dup = await acc(users[0], "/api/v1/wallet/enroll", "POST", { country: "PH", commitment: new Identity().commitment.toString() });
check("second identity for same account is refused (ALREADY_ENROLLED)", dup.status === 409 && dup.body.error.code === "ALREADY_ENROLLED");
const noCsrf = await json(await fetch(`${ACC}/api/v1/wallet/enroll`, { method: "POST", headers: { cookie: users[0].jar.header, origin: WEB, "content-type": "application/json" }, body: "{}" }));
check("enrollment without CSRF token is rejected", noCsrf.status === 403);

await tick(); // publish submit roots, promote (dev maturity 0h) to countable, publish countable roots
const roots = await verifiedRoots();
check("signed roots published for submit + countable groups", roots.some((r) => r.group === "submit") && roots.some((r) => r.group === "countable"));

const LTO = await entityId("Land Transportation Office");
const BIR = await entityId("Bureau of Internal Revenue");
const before = await score(LTO);

console.log("\n2. Valid anonymous ballot (no cookies, no login)");
const [A, B, C] = users.map((u) => u.identity);
const bA = await makeBallot(A, LTO, "UPSERT", 8, { group: "countable" });
const okA = await put(bA);
check("countable proof accepted → status 'submitted' with receipt", okA.status === 200 && okA.body.status === "submitted" && okA.body.receipt, JSON.stringify(okA.body));
check("acknowledgment does not reveal counting status", !("counted" in okA.body) && !("trust" in okA.body) && Object.keys(okA.body).sort().join() === "nextEditableAt,receipt,status");

console.log("\n3. Rejections (AC-02)");
check("replayed challenge rejected", (await put(bA)).body.error?.code === "REPLAYED_CHALLENGE");
const bA2 = await makeBallot(A, LTO, "UPSERT", 8, { group: "countable" });
check("score tampered after proving → INVALID_PROOF", (await put({ ...bA2, score: 9 })).body.error?.code === "INVALID_PROOF");
for (const bad of [0, 11, 8.5, "8", null]) {
  check(`score ${JSON.stringify(bad)} rejected (INVALID_SCORE)`, (await put({ ...bA2, score: bad })).body.error?.code === "INVALID_SCORE");
}
check("cookie header rejected", (await vote(`/anonymous/v1/ballots/${LTO}`, "PUT", strip(bA2), { cookie: "gz_session=abc" })).body.error?.code === "CREDENTIALS_NOT_ALLOWED");
check("Authorization header rejected", (await vote(`/anonymous/v1/ballots/${LTO}`, "PUT", strip(bA2), { authorization: "Bearer x" })).body.error?.code === "CREDENTIALS_NOT_ALLOWED");
check("identifying Referer rejected", (await vote(`/anonymous/v1/ballots/${LTO}`, "PUT", strip(bA2), { referer: `${WEB}/ph/agency/lto` })).body.error?.code === "CREDENTIALS_NOT_ALLOWED");
const fakeRoot = { ...bA2, groupRoot: "12345", proof: { ...bA2.proof, merkleTreeRoot: "12345" } };
check("unapproved group root rejected", (await put(fakeRoot)).body.error?.code === "UNAPPROVED_GROUP_ROOT");
const flipped = { ...bA2, proof: { ...bA2.proof, points: [...bA2.proof.points.slice(0, 7), (BigInt(bA2.proof.points[7]) + 1n).toString()] } };
check("corrupted proof points rejected", (await put(flipped)).body.error?.code === "INVALID_PROOF");
const wrongScope = await makeBallot(A, LTO, "UPSERT", 8, { group: "countable", entityForScope: BIR });
check("proof scoped to another entity rejected", (await put(wrongScope)).body.error?.code === "INVALID_PROOF");
check("fabricated challenge rejected", (await put({ ...bA2, challenge: "x".repeat(43) })).body.error?.code === "INVALID_PROOF");
const unknown = await vote("/anonymous/v1/challenges", "POST", { entityId: "00000000-0000-4000-8000-000000000000", operation: "UPSERT" });
check("unknown entity cannot be rated (ENTITY_NOT_RATABLE)", unknown.body.error?.code === "ENTITY_NOT_RATABLE");

console.log("\n4. Uniqueness & cooldown (AC-03, AC-04)");
const changeTooSoon = await put(await makeBallot(A, LTO, "UPSERT", 3, { group: "countable" }));
check("changing score within 30 days → VOTE_COOLDOWN with nextEditableAt", changeTooSoon.body.error?.code === "VOTE_COOLDOWN" && changeTooSoon.body.error.nextEditableAt);
const [p1, p2] = await Promise.all([makeBallot(B, LTO, "UPSERT", 5, { group: "countable" }), makeBallot(B, LTO, "UPSERT", 6, { group: "countable" })]);
const [r1, r2] = await Promise.all([put(p1), put(p2)]);
const rowsB = (await ballots(LTO)).filter((b) => b.scoped_nullifier === p1.nullifier);
check("two simultaneous proofs, same wallet+entity → exactly one ballot row", rowsB.length === 1, JSON.stringify([r1.body, r2.body]));
check("…and exactly one of them succeeded as a new score", [r1, r2].filter((r) => r.status === 200).length >= 1);
const bBir = await makeBallot(A, BIR, "UPSERT", 4, { group: "countable" });
check("same wallet, different agencies → different, unlinkable nullifiers (AC-18)", bBir.nullifier !== bA.nullifier);
check("same wallet, same agency → same nullifier across proofs", bA2.nullifier === bA.nullifier);
await put(bBir);

console.log("\n5. Submit-group-only ballots are stored but never counted (AC-15)");
const D = await signIn(`e2e-${run}-submit-only`);
D.identity = new Identity();
await acc(D, "/api/v1/wallet/enroll", "POST", { country: "PH", commitment: D.identity.commitment.toString() });
await new Promise((r) => setTimeout(r, 1500)); // instant epoch publication (dev) runs in waitUntil
const bD = await makeBallot(D.identity, LTO, "UPSERT", 1, { group: "submit" });
const okD = await put(bD);
check("submit-only proof → 'submitted' (same acknowledgment)", okD.status === 200 && okD.body.status === "submitted");
const rowD = (await ballots(LTO)).find((b) => b.scoped_nullifier === bD.nullifier);
check("…stored with trust_group 'submit' and PROVISIONAL", rowD?.trust_group === "submit" && rowD?.status === "PROVISIONAL");

console.log("\n6. 24-hour maturation → COUNTED; public score derived only from COUNTED");
const bC = await makeBallot(C, LTO, "UPSERT", 9, { group: "countable" });
await put(bC);
let s1 = await score(LTO);
check("nothing counts before the 24 h hold", s1.count === before.count, JSON.stringify(s1));
await age(25);
await tick();
await new Promise((r) => setTimeout(r, 2500));
const rows = await ballots(LTO);
check("countable ballots matured to COUNTED", rows.filter((b) => b.status === "COUNTED").length >= 3);
check("submit-only ballot still not counted", rows.find((b) => b.scoped_nullifier === bD.nullifier)?.status === "PROVISIONAL");
s1 = await score(LTO);
const countedRows = rows.filter((b) => b.status === "COUNTED" && b.score !== null).length;
check("public count equals exactly the COUNTED ballots (≥ 3 new)", s1.count === countedRows && s1.count >= before.count + 3, JSON.stringify({ before: before.count, after: s1.count, countedRows }));

console.log("\n7. Update after cooldown replaces (does not add) — AC-04");
await age(24 * 31, true);
const upd = await put(await makeBallot(A, LTO, "UPSERT", 2, { group: "countable" }));
check("update after 30 days accepted", upd.status === 200, JSON.stringify(upd.body));
const rowsA = (await ballots(LTO)).filter((b) => b.scoped_nullifier === bA.nullifier);
check("still exactly one row for that nullifier, revision bumped", rowsA.length === 1 && rowsA[0].revision >= 2 && rowsA[0].score === 2);
await age(25);
await tick();
await new Promise((r) => setTimeout(r, 2500));
const s2 = await score(LTO);
check("count unchanged after update (replaced, not added)", s2.count === s1.count, JSON.stringify({ s1: s1.count, s2: s2.count }));

console.log("\n8. Wallet-authorized deletion (AC-04)");
const dl = await del(await makeBallot(C, LTO, "DELETE", null, { group: "countable" }));
check("DELETE proof accepted → 'deleted'", dl.status === 200 && dl.body.status === "deleted");
await new Promise((r) => setTimeout(r, 2500));
const s3 = await score(LTO);
check("deletion removes its eligible count", s3.count === s2.count - 1, JSON.stringify({ s2: s2.count, s3: s3.count }));
// C's clock was aged past 30 days in step 7, so one re-rate is legitimately allowed…
const reRate = await put(await makeBallot(C, LTO, "UPSERT", 7, { group: "countable" }));
check("re-rating after a past-cooldown delete is allowed (new score, fresh clock)", reRate.status === 200, JSON.stringify(reRate.body));
// …but deleting again and re-rating immediately must hit the cooldown.
await del(await makeBallot(C, LTO, "DELETE", null, { group: "countable" }));
const reAdd = await put(await makeBallot(C, LTO, "UPSERT", 9, { group: "countable" }));
check("delete-then-re-rate cannot bypass the 30-day cooldown", reAdd.body.error?.code === "VOTE_COOLDOWN", JSON.stringify(reAdd.body));

console.log("\n9. Receipts, status lookups and appeals (no identity disclosed)");
const rec = await vote("/anonymous/v1/receipts/lookup", "POST", { receipt: okA.body.receipt });
check("receipt lookup → 'submitted' only (no screening state)", rec.status === 200 && rec.body.status === "submitted" && Object.keys(rec.body).sort().join() === "nextEditableAt,status");
const ap = await makeBallot(A, LTO, "APPEAL", null, { group: "countable" });
const appeal = await vote("/anonymous/v1/appeals", "POST", { ...strip(ap), receipt: okA.body.receipt });
check("anonymous appeal with receipt + fresh proof → 'appeal_received'", appeal.status === 200 && appeal.body.status === "appeal_received", JSON.stringify(appeal.body));
const apWrong = await makeBallot(B, LTO, "APPEAL", null, { group: "countable" });
check("appeal with someone else's receipt is rejected", (await vote("/anonymous/v1/appeals", "POST", { ...strip(apWrong), receipt: okA.body.receipt })).body.error?.code === "INVALID_PROOF");

console.log("\n10. Quarantine removes exactly one contribution; clearing restores it (AC-16)");
const target = (await ballots(LTO)).find((b) => b.status === "COUNTED");
const form = new URLSearchParams();
form.append("ballot", target.id);
form.append("reason", "STAFF_REVIEW");
await fetch(`${ADMIN}/moderation/entity/${LTO}/quarantine`, { method: "POST", redirect: "manual", headers: { origin: ADMIN, "content-type": "application/x-www-form-urlencoded" }, body: form });
await new Promise((r) => setTimeout(r, 2500));
const s4 = await score(LTO);
check("quarantining a COUNTED ballot removes its contribution", s4.count === s3.count - 1, JSON.stringify({ s3: s3.count, s4: s4.count }));
const casesHtml = await (await fetch(`${ADMIN}/moderation/cases?state=OPEN`)).text();
const caseId = [...casesHtml.matchAll(/\/moderation\/cases\/(BC-[A-Z0-9]+)/g)].map((m) => m[1])[0];
await fetch(`${ADMIN}/moderation/cases/${caseId}`, { method: "POST", redirect: "manual", headers: { origin: ADMIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ decision: "CLEAR", note: "e2e: evidence insufficient" }) });
await new Promise((r) => setTimeout(r, 2500));
const s5 = await score(LTO);
check("clearing the case restores only that one contribution", s5.count === s3.count, JSON.stringify({ s5: s5.count }));
const crossOrigin = await fetch(`${ADMIN}/moderation/cases/${caseId}`, { method: "POST", redirect: "manual", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: "decision=EXCLUDE" });
check("admin rejects cross-origin form posts", crossOrigin.status === 403);

console.log("\n11. Rankings list every listing from its first eligible rating and nothing unrated (AC-07, floor lowered to 1)");
const rk = (await json(await fetch(`${WEB}/api/v1/rankings?type=AGENCY&kind=best`))).body;
check("every ranked row has at least one eligible rating", rk.rows.every((r) => r.count >= 1), JSON.stringify(rk.rows.map((r) => r.count)));
check("the LTO, rated above, is ranked", rk.rows.some((r) => r.entityId === LTO), JSON.stringify(rk.rows.map((r) => r.name)));
check("snapshot advertises the floor of 1", rk.minVotes === 1, JSON.stringify({ minVotes: rk.minVotes }));

console.log("\n12. Account deletion revokes future membership (AC-05)");
const delAcc = await acc(users[2], "/api/v1/me", "DELETE", { confirm: "DELETE MY ACCOUNT" });
check("account deleted", delAcc.status === 200);
await tick();
const stillMember = await membership(C);
check("deleted account's commitment is no longer in any accepted root", stillMember === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
