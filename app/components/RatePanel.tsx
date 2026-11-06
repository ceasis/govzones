import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useConfig } from "../lib/config";
import { applyAck, jitter, useWallet } from "../wallet/WalletContext";
import { SCORING } from "../../shared/scoring";

type Stage = "membership" | "challenge" | "artifacts" | "tree" | "proving" | "submitting";
type Phase =
  | { k: "idle" }
  | { k: "working"; stage: Stage; op: "UPSERT" | "DELETE" }
  | { k: "queued" }
  | { k: "done"; op: "UPSERT" | "DELETE"; nextEditableAt?: string }
  | { k: "error"; message: string };

const STAGE_TEXT: Record<Stage, string> = {
  membership: "Checking your voting pass…",
  challenge: "Getting ready to send…",
  artifacts: "Loading the privacy tools (first time only, about 5 MB)…",
  tree: "Preparing your anonymous rating…",
  proving: "Making your rating anonymous. This can take a few seconds on a phone…",
  submitting: "Sending anonymously…",
};

const ERROR_TEXT: Record<string, string> = {
  VOTE_COOLDOWN: "You can change this rating once every 30 days.",
  ENTITY_NOT_RATABLE: "This listing cannot be rated right now.",
  INVALID_SCORE: "Ratings must be a whole number from 1 to 10.",
  RATE_LIMITED: "Too many requests from your network. Please wait a minute and try again.",
  ARTIFACT_INTEGRITY: "The privacy tools did not load correctly, so nothing was sent. Please reload the page.",
  CANCELLED: "Cancelled. Nothing was submitted.",
};

export const INTENT_KEY = "govzones:intent";

export interface RateIntent {
  entityId: string;
  country: string;
  name: string;
  path: string;
  score: number;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", year: "numeric", month: "long", day: "numeric" });
}

export function RatePanel({ entity, country, kindLabel }: { entity: { id: string; name: string; path: string; ratable: boolean }; country: string; kindLabel: string }) {
  const config = useConfig();
  const { wallet, status, session, update, queue } = useWallet();
  const navigate = useNavigate();
  const [score, setScore] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const abort = useRef<AbortController | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  const mine = wallet?.ratings[entity.id];
  const active = mine?.status === "submitted" ? mine : null;
  const pending = wallet?.pending[entity.id];
  const locked = active?.nextEditableAt ? Date.parse(active.nextEditableAt) > Date.now() : false;
  const identity = wallet?.identities[country];

  useEffect(() => {
    if (phase.k !== "idle") statusRef.current?.focus();
  }, [phase.k]);

  if (!entity.ratable) {
    return (
      <section aria-labelledby="rate-h" className="card">
        <h2 id="rate-h" className="text-lg font-bold">
          Rate this {kindLabel}
        </h2>
        <p className="mt-2 text-sm text-muted">This listing is not open for rating (it may be closed, merged or awaiting verification).</p>
      </section>
    );
  }

  const run = async (op: "UPSERT" | "DELETE") => {
    if (op === "UPSERT" && score === null) return;
    if (!wallet || !identity) {
      const intent: RateIntent = { entityId: entity.id, country, name: entity.name, path: entity.path, score: score! };
      // Kept only in this tab; the account host is never told which entity you were rating.
      sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
      navigate(session?.signedIn ? "/me/wallet?continue=1" : "/sign-in");
      return;
    }
    abort.current = new AbortController();
    setPhase({ k: "working", stage: "membership", op });
    const target = { entityId: entity.id, country, name: entity.name, path: entity.path, operation: op, score: op === "UPSERT" ? score : null };
    try {
      const { castBallot, MembershipPendingError } = await import("../wallet/clients");
      try {
        const ack = await castBallot({
          cfg: config,
          country,
          entityId: entity.id,
          operation: op,
          score: target.score,
          identity,
          onStage: (stage) => setPhase({ k: "working", stage, op }),
          signal: abort.current.signal,
        });
        await update((w) => {
          delete w.pending[entity.id];
          applyAck(w, target, ack);
          w.backup.dirty = true;
        });
        setPhase({ k: "done", op, nextEditableAt: ack.nextEditableAt });
        setScore(null);
      } catch (err) {
        if (err instanceof MembershipPendingError) {
          await queue(target, jitter(20_000, 90_000));
          setPhase({ k: "queued" });
          return;
        }
        throw err;
      }
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      const next = (err as { extra?: { nextEditableAt?: string } }).extra?.nextEditableAt;
      const message =
        code === "VOTE_COOLDOWN" && next
          ? `You can change this rating after ${formatDate(next)}.`
          : (ERROR_TEXT[code] ?? (err instanceof Error ? err.message : "Something went wrong. Nothing was counted twice; please try again."));
      setPhase({ k: "error", message });
    }
  };

  const working = phase.k === "working";

  return (
    <section aria-labelledby="rate-h" className="card">
      <h2 id="rate-h" className="text-lg font-bold">
        {active ? "Your rating" : `Rate this ${kindLabel}`}
      </h2>
      <p className="mt-1 text-sm text-muted">Rate an agency or office you have used. One whole number: 1 = Very poor, 10 = Excellent.</p>

      {active && (
        <p className="notice-ok mt-3">
          You rated this <strong>{active.score} / 10</strong> on {formatDate(active.submittedAt)}.{" "}
          {active.nextEditableAt && locked ? <>You can change it after {formatDate(active.nextEditableAt)}.</> : <>You can update it now.</>}
        </p>
      )}
      {pending && phase.k !== "queued" && (
        <p className="notice mt-3">
          Your {pending.operation === "DELETE" ? "deletion" : `rating of ${pending.score} / 10`} is waiting to be sent once your voting pass is active.
        </p>
      )}

      {(!active || !locked) && (
        <fieldset className="mt-4" disabled={working}>
          <legend className="sr-only">Choose a score from 1 to 10</legend>
          <div className="grid grid-cols-5 gap-2">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <label key={n} className="relative block min-w-0">
                <input
                  type="radio"
                  name="score"
                  value={n}
                  className="peer sr-only"
                  checked={score === n}
                  onChange={() => setScore(n)}
                  aria-label={`${n}${n === 1 ? " (very poor)" : n === 10 ? " (excellent)" : ""}`}
                />
                <span className="flex min-h-12 cursor-pointer items-center justify-center rounded-lg border-2 border-ink/25 bg-paper text-lg font-bold tabular-nums peer-checked:border-accent-strong peer-checked:bg-accent peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-3 peer-focus-visible:outline-amber-500">
                  {n}
                  {score === n && <span aria-hidden="true" className="ml-0.5 text-sm">✓</span>}
                </span>
              </label>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-muted" aria-hidden="true">
            <span>1 = Very poor</span>
            <span>10 = Excellent</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={score === null || working} onClick={() => run("UPSERT")}>
              {active ? "Update your rating" : "Submit rating"}
            </button>
          </div>
        </fieldset>
      )}

      {active && (
        <div className="mt-3">
          <button type="button" className="btn-danger" disabled={working} onClick={() => run("DELETE")}>
            Delete my rating
          </button>
        </div>
      )}

      <div ref={statusRef} tabIndex={-1} role="status" aria-live="polite" className="mt-4 outline-none">
        {phase.k === "working" && (
          <div className="rounded-lg border border-line bg-slate-50 p-3">
            <p className="flex items-center gap-2 font-medium">
              <span aria-hidden="true" className="inline-block size-4 animate-spin rounded-full border-2 border-accent border-t-transparent motion-reduce:animate-none" />
              {STAGE_TEXT[phase.stage]}
            </p>
            <p className="mt-1 text-sm text-muted">Your rating is made anonymous on this device before it is sent. Your login is never sent with it.</p>
            <button type="button" className="btn-secondary mt-2" onClick={() => abort.current?.abort()}>
              Cancel
            </button>
          </div>
        )}
        {phase.k === "queued" && (
          <p className="notice">
            Your voting pass is still being activated (new passes are activated in groups, to protect anonymity). Your rating is saved on this device
            and will be sent automatically the next time you open GovZones after that.
          </p>
        )}
        {phase.k === "done" && (
          <div className="notice-ok">
            <p className="font-semibold">{phase.op === "DELETE" ? "Your rating was deleted." : "Your rating was submitted."}</p>
            {phase.op === "UPSERT" && (
              <p className="mt-1">
                It is now checked and held for {SCORING.maturationHours} hours before it is counted.
                {phase.nextEditableAt ? ` You can change it after ${formatDate(phase.nextEditableAt)}.` : ""}
              </p>
            )}
          </div>
        )}
        {phase.k === "error" && (
          <div className="notice">
            <p>{phase.message}</p>
            <button type="button" className="btn-secondary mt-2" onClick={() => setPhase({ k: "idle" })}>
              Try again
            </button>
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-muted">
        {status === "ready" ? "Your voting pass is on this device." : "To rate, sign in once (free) to get a private voting pass."} Ratings are anonymous: no
        names, no profiles, no “who rated this” lists. Only ratings that pass our checks are counted.{" "}
        <Link to="/about" className="link">
          How anonymity works
        </Link>
      </p>
    </section>
  );
}
