/**
 * Client-only wallet + session state. Nothing here renders on the server, and the
 * authenticated session is never attached to a ballot request.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PublicConfig } from "../lib/config";
import type { SessionInfo } from "./clients";
import type { PendingAction, WalletData, WalletRating } from "./wallet";

type Status = "loading" | "none" | "ready" | "error";

export interface WalletApi {
  status: Status;
  wallet: WalletData | null;
  session: SessionInfo | null;
  refreshSession: () => Promise<SessionInfo | null>;
  reload: () => Promise<void>;
  update: (fn: (w: WalletData) => void) => Promise<WalletData | null>;
  queue: (action: Omit<PendingAction, "queuedAt" | "notBefore">, delayMs?: number) => Promise<void>;
  processing: boolean;
  lastBackgroundResult: string | null;
}

const Ctx = createContext<WalletApi | null>(null);

/** Random delay so a submission is not timed to coincide with sign-in or enrollment. */
export function jitter(minMs: number, maxMs: number) {
  const r = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  return Math.round(minMs + r * (maxMs - minMs));
}

export function WalletProvider({ config, children }: { config: PublicConfig; children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [processing, setProcessing] = useState(false);
  const [lastBackgroundResult, setLast] = useState<string | null>(null);
  const busy = useRef(false);
  const walletRef = useRef<WalletData | null>(null);
  walletRef.current = wallet;

  const reload = useCallback(async () => {
    try {
      const { loadWallet } = await import("./wallet");
      const w = await loadWallet();
      setWallet(w);
      setStatus(w ? "ready" : "none");
    } catch {
      setStatus("error");
    }
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const { fetchSession } = await import("./clients");
      const s = await fetchSession(config);
      setSession(s);
      return s;
    } catch {
      setSession({ signedIn: false });
      return null;
    }
  }, [config]);

  const update = useCallback(async (fn: (w: WalletData) => void) => {
    const { loadWallet, saveWallet } = await import("./wallet");
    const w = await loadWallet();
    if (!w) return null;
    fn(w);
    await saveWallet(w);
    setWallet({ ...w });
    return w;
  }, []);

  const queue = useCallback(
    async (action: Omit<PendingAction, "queuedAt" | "notBefore">, delayMs = jitter(5_000, 25_000)) => {
      await update((w) => {
        w.pending[action.entityId] = {
          ...action,
          queuedAt: new Date().toISOString(),
          notBefore: new Date(Date.now() + delayMs).toISOString(),
        };
      });
    },
    [update],
  );

  useEffect(() => {
    void reload();
    void refreshSession();
  }, [reload, refreshSession]);

  /** Background: submit queued ballots and perform jittered same-score trust upgrades. */
  useEffect(() => {
    if (status !== "ready") return;
    const run = async () => {
      const w = walletRef.current;
      if (busy.current || !w) return;
      const now = Date.now();
      const due = Object.values(w.pending).find((p) => Date.parse(p.notBefore) <= now);
      const upgrade = !due
        ? Object.values(w.ratings).find(
            (r) => r.status === "submitted" && r.upgradeAfter && Date.parse(r.upgradeAfter) <= now && !(r.provenGroup === "countable" && r.provenAnonymityOk),
          )
        : undefined;
      if (!due && !upgrade) return;
      busy.current = true;
      setProcessing(true);
      try {
        const { castBallot, MembershipPendingError } = await import("./clients");
        const target = due ?? {
          entityId: upgrade!.entityId,
          country: upgrade!.country,
          name: upgrade!.name,
          path: upgrade!.path,
          operation: "UPSERT" as const,
          score: upgrade!.score,
        };
        const identity = w.identities[target.country];
        if (!identity) return;
        try {
          const ack = await castBallot({
            cfg: config,
            country: target.country,
            entityId: target.entityId,
            operation: target.operation,
            score: target.score,
            identity,
          });
          await update((x) => {
            delete x.pending[target.entityId];
            applyAck(x, target, ack);
            x.backup.dirty = true;
          });
          setLast(`${target.operation === "DELETE" ? "Deleted" : "Submitted"}: ${target.name}`);
        } catch (err) {
          if (err instanceof MembershipPendingError) {
            await update((x) => {
              if (x.pending[target.entityId]) x.pending[target.entityId].notBefore = new Date(Date.now() + jitter(60_000, 180_000)).toISOString();
              else if (x.ratings[target.entityId]) x.ratings[target.entityId].upgradeAfter = new Date(Date.now() + jitter(3_600_000, 6 * 3_600_000)).toISOString();
            });
          } else {
            const code = (err as { code?: string }).code ?? "ERROR";
            await update((x) => {
              if (x.pending[target.entityId]) {
                if (["VOTE_COOLDOWN", "ENTITY_NOT_RATABLE", "INVALID_SCORE"].includes(code)) delete x.pending[target.entityId];
                else x.pending[target.entityId].notBefore = new Date(Date.now() + jitter(120_000, 600_000)).toISOString();
              } else if (x.ratings[target.entityId]) {
                x.ratings[target.entityId].upgradeAfter = null;
              }
            });
            setLast(`Could not submit "${target.name}" (${code}).`);
          }
        }
      } finally {
        busy.current = false;
        setProcessing(false);
      }
    };
    const id = window.setInterval(run, 5_000);
    void run();
    return () => window.clearInterval(id);
  }, [status, config, update]);

  const api = useMemo<WalletApi>(
    () => ({ status, wallet, session, refreshSession, reload, update, queue, processing, lastBackgroundResult }),
    [status, wallet, session, refreshSession, reload, update, queue, processing, lastBackgroundResult],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function applyAck(
  w: WalletData,
  target: { entityId: string; country: string; name: string; path: string; operation: "UPSERT" | "DELETE"; score: number | null },
  ack: { status: "submitted" | "deleted"; receipt?: string; nextEditableAt?: string; group: "submit" | "countable"; anonymityOk: boolean },
) {
  const prev = w.ratings[target.entityId];
  if (ack.status === "deleted") {
    if (prev) w.ratings[target.entityId] = { ...prev, status: "deleted", upgradeAfter: null };
    return;
  }
  const fullyTrusted = ack.group === "countable" && ack.anonymityOk;
  const rating: WalletRating = {
    entityId: target.entityId,
    country: target.country,
    name: target.name,
    path: target.path,
    score: target.score!,
    status: "submitted",
    submittedAt: prev && prev.score === target.score && prev.status === "submitted" ? prev.submittedAt : new Date().toISOString(),
    nextEditableAt: ack.nextEditableAt ?? prev?.nextEditableAt ?? null,
    receipt: ack.receipt ?? prev?.receipt ?? null,
    provenGroup: ack.group,
    provenAnonymityOk: ack.anonymityOk,
    // Spread automatic upgrades over hours so they do not reveal which ballots share a wallet.
    upgradeAfter: fullyTrusted ? null : new Date(Date.now() + jitter(6 * 3_600_000, 72 * 3_600_000)).toISOString(),
  };
  w.ratings[target.entityId] = rating;
}

export function useWallet(): WalletApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("WalletProvider missing");
  return v;
}
