/** Main-thread wrapper: one short-lived Web Worker per proof (freed afterwards; cancellable). */
import type { ProveRequest, ProverMessage } from "./prover.worker";
import type { SemaphoreProofPayload } from "../../shared/zk/verify";

export type ProofStage = "artifacts" | "tree" | "proving";

export class ProverError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function prove(req: ProveRequest, onStage: (s: ProofStage) => void, signal?: AbortSignal): Promise<SemaphoreProofPayload> {
  return new Promise((resolve, reject) => {
    if (typeof Worker === "undefined") {
      reject(new ProverError("UNSUPPORTED", "This browser cannot send anonymous ratings. Please try a current browser."));
      return;
    }
    const worker = new Worker(new URL("./prover.worker.ts", import.meta.url), { type: "module", name: "govzones-prover" });
    const done = () => worker.terminate();
    signal?.addEventListener("abort", () => {
      done();
      reject(new ProverError("CANCELLED", "Cancelled."));
    });
    worker.onmessage = (ev: MessageEvent<ProverMessage>) => {
      const m = ev.data;
      if (m.type === "progress") onStage(m.stage);
      else if (m.type === "result") {
        done();
        resolve(m.proof as unknown as SemaphoreProofPayload);
      } else {
        done();
        reject(new ProverError(m.code, m.message));
      }
    };
    worker.onerror = (e) => {
      done();
      reject(new ProverError("PROOF_FAILED", e.message || "Making your rating anonymous failed, possibly because the device ran out of memory."));
    };
    worker.postMessage(req);
  });
}
