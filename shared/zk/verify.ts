/**
 * Groth16 verifier for pinned Semaphore v4 proofs, implemented on the audited
 * @noble/curves BN254 pairing so it runs inside Cloudflare Workers.
 *
 * Why not snarkjs: snarkjs/ffjavascript compiles WebAssembly at runtime and uses
 * URL.createObjectURL, both unavailable in workerd (verified in the feasibility spike).
 *
 * This file uses the exact verification keys shipped with @semaphore-protocol/proof
 * (vendored; tests assert byte equality) and is cross-checked against snarkjs in tests.
 * It is security-critical code and is listed as an independent-audit launch gate.
 */
import { bn254 } from "@noble/curves/bn254.js";
import { MAX_PROOF_DEPTH, SNARK_FIELD, isFieldElementString, semaphoreHash } from "../protocol";
import verificationKeys from "./semaphore-verification-keys.json";

export interface SemaphoreProofPayload {
  merkleTreeDepth: number;
  merkleTreeRoot: string;
  nullifier: string;
  message: string;
  scope: string;
  points: string[];
}

type G1Json = string[];
type G2Json = string[][];

const { G1, G2, fields } = bn254;
const Fp = fields.Fp;
const Fp2 = fields.Fp2;
const Fp12 = fields.Fp12;

function toCoord(value: string): bigint {
  if (!/^[0-9]{1,78}$/.test(value)) throw new TypeError("coordinate must be a decimal string");
  const v = BigInt(value);
  if (v >= Fp.ORDER) throw new RangeError("coordinate outside base field");
  return v;
}

function g1Point(x: string, y: string) {
  const p = G1.Point.fromAffine({ x: toCoord(x), y: toCoord(y) });
  p.assertValidity();
  return p;
}

function g2Point(x0: string, x1: string, y0: string, y1: string) {
  const p = G2.Point.fromAffine({
    x: Fp2.fromBigTuple([toCoord(x0), toCoord(x1)]),
    y: Fp2.fromBigTuple([toCoord(y0), toCoord(y1)]),
  });
  // assertValidity() checks the curve equation AND prime-order subgroup membership
  // (bn254 G2 has cofactor != 1; noble's isTorsionFree uses the psi endomorphism check).
  p.assertValidity();
  if (!p.isTorsionFree()) throw new Error("G2 point not in subgroup");
  return p;
}

const g1FromJson = (p: G1Json) => g1Point(p[0], p[1]);
const g2FromJson = (p: G2Json) => g2Point(p[0][0], p[0][1], p[1][0], p[1][1]);

interface VkCache {
  alpha: ReturnType<typeof g1FromJson>;
  beta: ReturnType<typeof g2FromJson>;
  gamma: ReturnType<typeof g2FromJson>;
  delta: Map<number, ReturnType<typeof g2FromJson>>;
  ic: Map<number, ReturnType<typeof g1FromJson>[]>;
}
let vkCache: VkCache | null = null;

function vk(depth: number) {
  if (!vkCache) {
    vkCache = {
      alpha: g1FromJson(verificationKeys.vk_alpha_1 as G1Json),
      beta: g2FromJson(verificationKeys.vk_beta_2 as G2Json),
      gamma: g2FromJson(verificationKeys.vk_gamma_2 as G2Json),
      delta: new Map(),
      ic: new Map(),
    };
  }
  if (!vkCache.delta.has(depth)) {
    vkCache.delta.set(depth, g2FromJson((verificationKeys.vk_delta_2 as G2Json[])[depth - 1]));
    vkCache.ic.set(depth, (verificationKeys.IC as G1Json[][])[depth - 1].map(g1FromJson));
  }
  return { ...vkCache, deltaD: vkCache.delta.get(depth)!, icD: vkCache.ic.get(depth)! };
}

/** Structural validation; never throws on hostile input. */
export function isWellFormedProof(value: unknown): value is SemaphoreProofPayload {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    Number.isInteger(p.merkleTreeDepth) &&
    (p.merkleTreeDepth as number) >= 1 &&
    (p.merkleTreeDepth as number) <= MAX_PROOF_DEPTH &&
    isFieldElementString(p.merkleTreeRoot) &&
    isFieldElementString(p.nullifier) &&
    typeof p.message === "string" &&
    /^[0-9]{1,78}$/.test(p.message) &&
    typeof p.scope === "string" &&
    /^[0-9]{1,78}$/.test(p.scope) &&
    Array.isArray(p.points) &&
    p.points.length === 8 &&
    p.points.every((c) => typeof c === "string" && /^[0-9]{1,78}$/.test(c))
  );
}

/**
 * Verifies a packed Semaphore v4 Groth16 proof.
 * Public signals (circuit order): [merkleTreeRoot, nullifier, hash(message), hash(scope)].
 * Returns false (never throws) for any malformed or invalid proof.
 */
export function verifySemaphoreProof(proof: SemaphoreProofPayload): boolean {
  try {
    if (!isWellFormedProof(proof)) return false;
    const signals = [
      BigInt(proof.merkleTreeRoot),
      BigInt(proof.nullifier),
      semaphoreHash(proof.message),
      semaphoreHash(proof.scope),
    ];
    if (signals.some((s) => s >= SNARK_FIELD)) return false;

    const pts = proof.points;
    // Packed (Solidity calldata) order: a.x a.y b.x.c1 b.x.c0 b.y.c1 b.y.c0 c.x c.y
    const A = g1Point(pts[0], pts[1]);
    const B = g2Point(pts[3], pts[2], pts[5], pts[4]);
    const C = g1Point(pts[6], pts[7]);

    const key = vk(proof.merkleTreeDepth);
    let vkX = key.icD[0];
    for (let i = 0; i < signals.length; i++) {
      if (signals[i] !== 0n) vkX = vkX.add(key.icD[i + 1].multiply(signals[i]));
    }
    // e(-A, B) · e(alpha, beta) · e(vkX, gamma) · e(C, delta) == 1
    const result = bn254.pairingBatch([
      { g1: A.negate(), g2: B },
      { g1: key.alpha, g2: key.beta },
      { g1: vkX, g2: key.gamma },
      { g1: C, g2: key.deltaD },
    ]);
    return Fp12.eql(result, Fp12.ONE);
  } catch {
    return false;
  }
}
