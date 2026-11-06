import { describe, expect, it } from "vitest";
import { SCORING, bayesianScore, cohortMeanOf, formatScore, lowestFirst, publicHistogram, rankRows } from "../shared/scoring";
import { ballotMessage, entityScope, hashToField, isValidScore, proofDepthFor, SNARK_FIELD } from "../shared/protocol";
import { canonicalJson, importSigningKey, importVerifyKey, signRecord, verifySignedRoot, type RootRecord } from "../shared/signing";
import { ftsQuery, normalizeText, slugify } from "../shared/directory";
import { decodeEnvelope, encodeEnvelope, generateRecoveryKey, normalizeRecoveryKey, openBackup, sealBackup, deriveBackupKey, newSalt } from "../app/wallet/crypto";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("scoring methodology", () => {
  it("Bayesian adjustment pulls small samples toward the cohort mean", () => {
    expect(bayesianScore({ count: 30, sum: 300 }, 6)).toBeCloseTo((30 / 50) * 10 + (20 / 50) * 6);
    expect(bayesianScore({ count: 0, sum: 0 }, 6)).toBe(6);
  });

  it("ranks every rated entity from its first rating; an explicit floor excludes thin rows; ties break by adjusted score, count, then name", () => {
    const rows = [
      { entityId: "a", name: "Zeta", count: 40, sum: 320 },
      { entityId: "b", name: "Alpha", count: 40, sum: 320 },
      { entityId: "c", name: "Big", count: 400, sum: 3000 },
      { entityId: "d", name: "Tiny", count: 29, sum: 290 },
      { entityId: "e", name: "Unrated", count: 0, sum: 0 },
    ];
    const mean = cohortMeanOf(rows)!;
    expect(SCORING.minRankingVotes).toBe(1);
    const ranked = rankRows(rows, mean);
    expect(ranked.map((r) => r.entityId)).toEqual(["d", "b", "a", "c"]);
    expect(ranked.every((r) => r.count >= 1)).toBe(true);
    const floored = rankRows(rows, mean, { minVotes: 30 });
    expect(floored.map((r) => r.entityId)).toEqual(["b", "a", "c"]);
    expect(lowestFirst(floored).map((r) => r.entityId)).toEqual(["c", "b", "a"]);
  });

  it("the prior keeps a single 10 from outranking a well-rated listing above the cohort mean", () => {
    const rows = [
      { entityId: "one", name: "One ten", count: 1, sum: 10 },
      { entityId: "many", name: "Many eights", count: 50, sum: 400 },
      { entityId: "low", name: "Many fives", count: 50, sum: 250 },
    ];
    const ranked = rankRows(rows, cohortMeanOf(rows)!);
    expect(ranked.map((r) => r.entityId)).toEqual(["many", "one", "low"]);
    expect(ranked[1].rawMean).toBe(10);
  });

  it("shows the full distribution from the first rating (small-number suppression is off)", () => {
    expect(publicHistogram([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0)).toBeNull();
    const h = publicHistogram([1, 0, 0, 0, 0, 0, 0, 0, 0, 1], 2)!;
    expect(h[0]).toEqual({ score: 1, count: 1, suppressed: false });
    expect(h[1]).toEqual({ score: 2, count: 0, suppressed: false });
    expect(h[9]).toEqual({ score: 10, count: 1, suppressed: false });
    expect(h.every((c) => !c.suppressed)).toBe(true);
  });

  it("formats averages to one decimal place", () => {
    expect(formatScore(7.75)).toBe("7.8");
    expect(formatScore(null)).toBe("–");
  });
});

describe("protocol derivations", () => {
  it("scope is per-entity, per-country and independent of score/time/root", () => {
    expect(entityScope("PH", A)).toBe(entityScope("PH", A));
    expect(entityScope("PH", A)).not.toBe(entityScope("PH", B));
    expect(entityScope("PH", A)).not.toBe(entityScope("SG", A));
    expect(entityScope("PH", A) < SNARK_FIELD).toBe(true);
  });

  it("message binds operation, entity, integer score and challenge", () => {
    const base = { operation: "UPSERT" as const, entityId: A, score: 7, challenge: "c".repeat(43) };
    const m = ballotMessage(base);
    expect(ballotMessage({ ...base, score: 8 })).not.toBe(m);
    expect(ballotMessage({ ...base, challenge: "d".repeat(43) })).not.toBe(m);
    expect(ballotMessage({ ...base, entityId: B })).not.toBe(m);
    expect(ballotMessage({ operation: "DELETE", entityId: A, challenge: base.challenge })).not.toBe(m);
    expect(() => ballotMessage({ ...base, score: 7.5 })).toThrow();
    expect(() => ballotMessage({ operation: "DELETE", entityId: A, score: 3, challenge: base.challenge })).toThrow();
  });

  it("domain separation is length-prefixed (no concatenation ambiguity)", () => {
    expect(hashToField("ab", "c")).not.toBe(hashToField("a", "bc"));
  });

  it("accepts only whole numbers 1–10", () => {
    for (const ok of [1, 5, 10]) expect(isValidScore(ok)).toBe(true);
    for (const bad of [0, 11, 8.5, "8", null, NaN, -1]) expect(isValidScore(bad)).toBe(false);
  });

  it("uses a fixed proof-depth floor so few artifacts are needed", () => {
    expect(proofDepthFor(1)).toBe(16);
    expect(proofDepthFor(70_000)).toBe(17);
  });
});

describe("signed group roots", () => {
  it("verifies genuine records and rejects tampering", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
    const record: RootRecord = {
      v: 1, country: "PH", group: "countable", epoch: 3, root: "123", memberCount: 150, leafCount: 152, proofDepth: 16,
      anonymityOk: true, validFrom: "2026-10-31T00:00:00.000Z", validUntil: "2026-11-07T00:00:00.000Z", snapshotSha256: "ab",
    };
    const signed = await signRecord(record, await importSigningKey(jwk));
    const vk = await importVerifyKey(jwk);
    expect(await verifySignedRoot(signed, vk)).toBe(true);
    expect(await verifySignedRoot({ ...signed, record: { ...record, anonymityOk: false } }, vk)).toBe(false);
    expect(await verifySignedRoot({ ...signed, payload: canonicalJson({ ...record, epoch: 4 }) }, vk)).toBe(false);
  });
});

describe("wallet encryption", () => {
  it("recovery keys are 160-bit, grouped, and normalise common typos", () => {
    const k = generateRecoveryKey();
    expect(k).toMatch(/^([A-Z0-9]{4}-){7}[A-Z0-9]{4}$/);
    expect(normalizeRecoveryKey(k.toLowerCase().replace(/-/g, " "))).toBe(k);
    expect(normalizeRecoveryKey("too-short")).toBeNull();
  });

  it("backup envelopes round-trip only with the right recovery key and are padded", async () => {
    const key = generateRecoveryKey();
    const salt = newSalt();
    const env = await sealBackup(await deriveBackupKey(key, salt), salt, JSON.stringify({ hello: "world" }));
    const s = encodeEnvelope(env);
    const opened = await openBackup(decodeEnvelope(s)!, key);
    expect(JSON.parse(opened.plaintext)).toEqual({ hello: "world" });
    await expect(openBackup(decodeEnvelope(s)!, generateRecoveryKey())).rejects.toBeTruthy();
    const big = await sealBackup(await deriveBackupKey(key, salt), salt, "x".repeat(10));
    const bigger = await sealBackup(await deriveBackupKey(key, salt), salt, "x".repeat(2000));
    expect(big.ct.length).toBe(bigger.ct.length);
  });
});

describe("directory text handling", () => {
  it("normalises diacritics and punctuation; builds safe FTS queries", () => {
    expect(normalizeText("Parañaque  City Hall!")).toBe("paranaque city hall");
    expect(slugify("DFA Office of Consular Affairs – ASEANA")).toBe("dfa-office-of-consular-affairs-aseana");
    expect(ftsQuery('DFA "Cebu" OR *')).toBe('"dfa"* "cebu"* "or"*');
    expect(ftsQuery("dfa cebu", "OR")).toBe('"dfa"* OR "cebu"*');
    expect(ftsQuery("  !!  ")).toBeNull();
  });
});

describe("admin access control (AC-12)", async () => {
  const { authenticate } = await import("../workers/admin/auth");
  it("refuses requests without a Cloudflare Access identity", async () => {
    expect(await authenticate(new Request("https://admin.govzones.com/"), { ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" })).toBeNull();
    expect(await authenticate(new Request("https://admin.govzones.com/", { headers: { "Cf-Access-Jwt-Assertion": "not.a.jwt" } }), {})).toBeNull();
  });
  it("never honours the development bypass on a non-localhost host", async () => {
    expect(await authenticate(new Request("https://admin.govzones.com/"), { ADMIN_DEV_BYPASS: "1" })).toBeNull();
    expect(await authenticate(new Request("http://admin.govzones.localhost:5173/"), { ADMIN_DEV_BYPASS: "1" })).toMatchObject({ dev: true });
  });
});
