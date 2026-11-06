import { useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/me.ratings";
import { useConfig } from "../lib/config";
import { applyAck, jitter, useWallet } from "../wallet/WalletContext";
import type { WalletRating } from "../wallet/wallet";

export const meta: Route.MetaFunction = () => [{ title: "My ratings · GovZones" }, { name: "robots", content: "noindex" }];

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium" }) : "—");

/**
 * Reconstructed entirely in the browser from the decrypted wallet. Status checks use each
 * rating's own anonymous receipt; there is no server endpoint listing ratings by account.
 */
export default function MyRatings() {
  const cfg = useConfig();
  const { status, wallet, update, processing, lastBackgroundResult } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, string>>({});

  if (status === "loading") return <div className="container-page py-8">Loading…</div>;
  if (!wallet) {
    return (
      <div className="container-page max-w-2xl py-8">
        <h1 className="text-2xl font-bold">My ratings</h1>
        <p className="mt-2 text-muted">There is no voting wallet in this browser. Your ratings list lives only inside your locked wallet.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link className="btn-primary" to="/me/wallet">
            Create or restore a wallet
          </Link>
          <Link className="btn-secondary" to="/sign-in">
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  const ratings = Object.values(wallet.ratings).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  const active = ratings.filter((r) => r.status === "submitted");
  const pending = Object.values(wallet.pending);
  const identity = wallet.identities.PH;

  const del = async (r: WalletRating) => {
    if (!identity) return;
    setBusy(r.entityId);
    setNote(null);
    try {
      const { castBallot } = await import("../wallet/clients");
      const target = { entityId: r.entityId, country: r.country, name: r.name, path: r.path, operation: "DELETE" as const, score: null };
      const ack = await castBallot({ cfg, country: r.country, entityId: r.entityId, operation: "DELETE", score: null, identity });
      await update((w) => {
        applyAck(w, target, ack);
        w.backup.dirty = true;
      });
      setNote(`Deleted your rating of ${r.name}.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not delete.");
    } finally {
      setBusy(null);
    }
  };

  const deleteAll = async () => {
    if (!window.confirm(`Delete all ${active.length} of your anonymous ratings? Each one is sent separately and anonymously, so this can take a while.`)) return;
    // Queued with spaced-out random delays rather than fired back-to-back.
    await update((w) => {
      let t = Date.now();
      for (const r of Object.values(w.ratings)) {
        if (r.status !== "submitted") continue;
        t += jitter(3_000, 12_000);
        w.pending[r.entityId] = { entityId: r.entityId, country: r.country, name: r.name, path: r.path, operation: "DELETE", score: null, queuedAt: new Date().toISOString(), notBefore: new Date(t).toISOString() };
      }
    });
    setNote("Deletion of all ratings is queued. Keep this page open until the list is empty.");
  };

  const check = async () => {
    const { receiptStatus } = await import("../wallet/clients");
    const out: Record<string, string> = {};
    for (const r of active) {
      if (!r.receipt) continue;
      try {
        const s = await receiptStatus(cfg, r.receipt);
        out[r.entityId] = s.status === "submitted" ? "Received" : s.status === "deleted" ? "Deleted" : "Not found";
      } catch {
        out[r.entityId] = "Could not check";
      }
    }
    setChecked(out);
  };

  return (
    <div className="container-page max-w-3xl py-8">
      <h1 className="text-2xl font-bold">My ratings</h1>
      <p className="mt-1 text-sm text-muted">
        This list is stored only in your locked wallet on this device. GovZones keeps no list of ratings by account and cannot rebuild it for you.
      </p>
      {(processing || lastBackgroundResult) && (
        <p className="notice mt-3" role="status">
          {processing ? "Submitting a queued action anonymously…" : lastBackgroundResult}
        </p>
      )}
      {note && (
        <p className="notice-ok mt-3" role="status">
          {note}
        </p>
      )}

      {pending.length > 0 && (
        <section className="mt-6" aria-labelledby="pending-h">
          <h2 id="pending-h" className="text-lg font-bold">
            Waiting to be submitted
          </h2>
          <ul className="mt-2 space-y-2">
            {pending.map((p) => (
              <li key={p.entityId} className="card text-sm">
                <Link className="link font-semibold" to={p.path}>
                  {p.name}
                </Link>{" "}
                — {p.operation === "DELETE" ? "deletion" : `rating ${p.score} / 10`}. Sent automatically when your voting pass is active (not before{" "}
                {new Date(p.notBefore).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", timeStyle: "short" })}).
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6" aria-labelledby="active-h">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="active-h" className="text-lg font-bold">
            Active ratings ({active.length})
          </h2>
          {active.length > 0 && (
            <button className="btn-secondary text-sm" onClick={check}>
              Check receipts
            </button>
          )}
        </div>
        {active.length === 0 ? (
          <p className="card mt-2 text-sm text-muted">You haven't rated anything from this wallet yet. Search for an office you have used.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {active.map((r) => {
              const canEdit = !r.nextEditableAt || Date.parse(r.nextEditableAt) <= Date.now();
              return (
                <li key={r.entityId} className="card flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 basis-60">
                    <Link className="link font-semibold" to={r.path}>
                      {r.name}
                    </Link>
                    <p className="text-sm text-muted">
                      Your rating <strong className="text-ink">{r.score} / 10</strong> · submitted {fmt(r.submittedAt)} ·{" "}
                      {canEdit ? "you can update it now" : `changeable after ${fmt(r.nextEditableAt)}`}
                    </p>
                    {checked[r.entityId] && <p className="text-xs text-muted">Receipt check: {checked[r.entityId]}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link className="btn-secondary text-sm" to={r.path}>
                      {canEdit ? "Update" : "View"}
                    </Link>
                    <button className="btn-danger text-sm" disabled={busy === r.entityId} onClick={() => del(r)}>
                      {busy === r.entityId ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card mt-6 text-sm" aria-labelledby="screen-h">
        <h2 id="screen-h" className="font-bold">
          About “received” ratings
        </h2>
        <p className="mt-1 text-muted">
          A receipt confirms GovZones received your rating. Our checks decide whether a rating is counted in public scores. We do not show the result for
          each rating, so the checks cannot be gamed. If you believe a genuine rating was wrongly held back, you can{" "}
          <Link className="link" to="/policies/appeals">
            file an anonymous appeal
          </Link>
          .
        </p>
      </section>

      <div className="mt-6 flex flex-wrap gap-2">
        <Link className="btn-secondary" to="/me/wallet">
          Wallet &amp; backup
        </Link>
        <Link className="btn-secondary" to="/me/account">
          Account
        </Link>
        {active.length > 0 && (
          <button className="btn-danger" onClick={deleteAll}>
            Delete all my anonymous ratings
          </button>
        )}
      </div>
    </div>
  );
}
