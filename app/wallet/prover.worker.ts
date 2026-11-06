/// <reference lib="webworker" />
/**
 * Off-main-thread Semaphore v4 proof generation.
 * Artifacts are self-hosted and must match the SHA-256 values compiled into this bundle.
 */
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import lock from "../../shared/zk/artifacts-lock.json";

export interface ProveRequest {
  privateKey: string;
  leaves: string[];
  depth: number;
  message: string;
  scope: string;
}

export type ProverMessage =
  | { type: "progress"; stage: "artifacts" | "tree" | "proving" }
  | { type: "result"; proof: Awaited<ReturnType<typeof generateProof>> }
  | { type: "error"; code: "NOT_A_MEMBER" | "ARTIFACT_INTEGRITY" | "ARTIFACT_MISSING" | "PROOF_FAILED"; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const CACHE = `govzones-zk-${lock.version}`;

async function sha256Hex(buf: ArrayBuffer) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadArtifact(name: string): Promise<Uint8Array> {
  const expected = (lock.files as Record<string, string>)[name];
  if (!expected) throw Object.assign(new Error(`No pinned hash for ${name}`), { code: "ARTIFACT_MISSING" });
  const url = `/zk/semaphore/${lock.version}/${name}`;
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
  } catch {
    cache = null;
  }
  let res = cache ? await cache.match(url) : undefined;
  if (!res) {
    res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) throw Object.assign(new Error(`Could not download ${name}`), { code: "ARTIFACT_MISSING" });
  }
  const buf = await res.clone().arrayBuffer();
  if ((await sha256Hex(buf)) !== expected) {
    if (cache) await cache.delete(url);
    throw Object.assign(new Error(`Integrity check failed for ${name}`), { code: "ARTIFACT_INTEGRITY" });
  }
  if (cache && !(await cache.match(url))) await cache.put(url, new Response(buf));
  return new Uint8Array(buf);
}

ctx.onmessage = async (ev: MessageEvent<ProveRequest>) => {
  const req = ev.data;
  const post = (m: ProverMessage) => ctx.postMessage(m);
  try {
    post({ type: "progress", stage: "artifacts" });
    const [wasm, zkey] = await Promise.all([
      loadArtifact(`semaphore-${req.depth}.wasm`),
      loadArtifact(`semaphore-${req.depth}.zkey`),
    ]);
    post({ type: "progress", stage: "tree" });
    const identity = Identity.import(req.privateKey);
    const group = new Group(req.leaves.map((l) => BigInt(l)));
    if (group.indexOf(identity.commitment) < 0) {
      post({ type: "error", code: "NOT_A_MEMBER", message: "This voting pass is not active yet." });
      return;
    }
    post({ type: "progress", stage: "proving" });
    const proof = await generateProof(identity, group, BigInt(req.message), BigInt(req.scope), req.depth, {
      wasm: wasm as unknown as string,
      zkey: zkey as unknown as string,
    });
    post({ type: "result", proof });
  } catch (err) {
    const code = (err as { code?: string }).code;
    post({
      type: "error",
      code: code === "ARTIFACT_INTEGRITY" || code === "ARTIFACT_MISSING" ? code : "PROOF_FAILED",
      message: err instanceof Error ? err.message : "Could not make your rating anonymous.",
    });
  }
};
