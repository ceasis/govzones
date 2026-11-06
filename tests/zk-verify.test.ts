import { describe, expect, it, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Identity, Group, generateProof, verifyProof } from "@semaphore-protocol/core";
import { verifySemaphoreProof, type SemaphoreProofPayload } from "../shared/zk/verify";
import { ballotMessage, computeNullifier, entityScope } from "../shared/protocol";

const ART = (d: number) => ({
  wasm: join(__dirname, `../public/zk/semaphore/4.13.0/semaphore-${d}.wasm`),
  zkey: join(__dirname, `../public/zk/semaphore/4.13.0/semaphore-${d}.zkey`),
});

const ENTITY = "d90d2a2a-d45d-567e-a6ce-4234be3ce8f8";
const OTHER = "14686c56-ff15-59d7-aff5-d4757244242e";

describe("vendored verification keys", () => {
  it("are byte-identical to the pinned @semaphore-protocol/proof release", () => {
    const vendored = readFileSync(join(__dirname, "../shared/zk/semaphore-verification-keys.json"));
    const upstream = readFileSync(join(__dirname, "../node_modules/@semaphore-protocol/proof/src/verification-keys.json"));
    expect(createHash("sha256").update(vendored).digest("hex")).toBe(createHash("sha256").update(upstream).digest("hex"));
  });
});

describe("noble Groth16 verifier vs snarkjs (real Semaphore v4 proofs)", () => {
  const ids = Array.from({ length: 5 }, () => new Identity());
  const group = new Group(ids.map((i) => i.commitment));
  const scope = entityScope("PH", ENTITY);
  const message = ballotMessage({ operation: "UPSERT", entityId: ENTITY, score: 8, challenge: "c".repeat(43) });
  let proof16: SemaphoreProofPayload;
  let proofNatural: SemaphoreProofPayload;

  beforeAll(async () => {
    proof16 = (await generateProof(ids[2], group, message, scope, 16, ART(16))) as unknown as SemaphoreProofPayload;
  });

  it("accepts a valid depth-16 proof exactly when snarkjs does", async () => {
    expect(await verifyProof(proof16 as never)).toBe(true);
    expect(verifySemaphoreProof(proof16)).toBe(true);
  });

  it("rejects tampered message, scope, nullifier, root, depth and points", async () => {
    const cases: SemaphoreProofPayload[] = [
      { ...proof16, message: (BigInt(proof16.message) + 1n).toString() },
      { ...proof16, scope: entityScope("PH", OTHER).toString() },
      { ...proof16, nullifier: (BigInt(proof16.nullifier) + 1n).toString() },
      { ...proof16, merkleTreeRoot: (BigInt(proof16.merkleTreeRoot) + 1n).toString() },
      { ...proof16, merkleTreeDepth: 17 },
      { ...proof16, points: [...proof16.points.slice(0, 7), (BigInt(proof16.points[7]) + 1n).toString()] },
      { ...proof16, points: ["0", "0", ...proof16.points.slice(2)] },
    ];
    for (const c of cases) {
      expect(verifySemaphoreProof(c)).toBe(false);
      expect(await verifyProof(c as never).catch(() => false)).toBe(false);
    }
  });

  it("never throws on hostile input", () => {
    for (const bad of [null, {}, { ...proof16, points: ["x"] }, { ...proof16, merkleTreeDepth: 99 }, { ...proof16, nullifier: "-1" }]) {
      expect(verifySemaphoreProof(bad as never)).toBe(false);
    }
  });

  it("computes the same nullifier as the circuit (wallet status lookups)", () => {
    expect(computeNullifier(ids[2].secretScalar, scope).toString()).toBe(proof16.nullifier);
  });

  it("nullifiers are stable per entity and differ across entities", async () => {
    proofNatural = (await generateProof(ids[2], group, 1n, scope, 16, ART(16))) as unknown as SemaphoreProofPayload;
    expect(proofNatural.nullifier).toBe(proof16.nullifier);
    expect(computeNullifier(ids[2].secretScalar, entityScope("PH", OTHER)).toString()).not.toBe(proof16.nullifier);
  });
});
