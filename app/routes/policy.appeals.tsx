import { useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/policy.appeals";
import { useConfig } from "../lib/config";
import { useWallet } from "../wallet/WalletContext";

export const meta: Route.MetaFunction = () => [{ title: "Fraud & appeals policy · GovZones" }];

function AppealTool() {
  const cfg = useConfig();
  const { wallet } = useWallet();
  const [entityId, setEntityId] = useState("");
  const [state, setState] = useState<{ k: "idle" | "working" | "done" | "error"; msg?: string }>({ k: "idle" });
  const ratings = wallet ? Object.values(wallet.ratings).filter((r) => r.status === "submitted" && r.receipt) : [];
  if (!wallet) return <p className="text-sm text-muted">Appeals are made from your voting wallet on the device where you hold it.</p>;
  if (ratings.length === 0) return <p className="text-sm text-muted">Your wallet has no ratings with receipts to appeal.</p>;
  return (
    <form
      className="card grid gap-3"
      onSubmit={async (ev) => {
        ev.preventDefault();
        const r = wallet.ratings[entityId];
        const identity = wallet.identities[r?.country ?? "PH"];
        if (!r?.receipt || !identity) return;
        setState({ k: "working" });
        try {
          const { submitAppeal } = await import("../wallet/clients");
          await submitAppeal({ cfg, country: r.country, entityId: r.entityId, identity, receipt: r.receipt });
          setState({ k: "done" });
        } catch (e) {
          setState({ k: "error", msg: e instanceof Error ? e.message : "Appeal failed." });
        }
      }}
    >
      <label className="label" htmlFor="appeal-r">
        Which rating?
      </label>
      <select id="appeal-r" className="field" value={entityId} onChange={(e) => setEntityId(e.target.value)} required>
        <option value="">Choose…</option>
        {ratings.map((r) => (
          <option key={r.entityId} value={r.entityId}>
            {r.name} — {r.score}/10
          </option>
        ))}
      </select>
      <p className="text-xs text-muted">
        Your appeal is sent anonymously with your receipt and proof that the rating is yours, without revealing who you are. No login is attached.
      </p>
      {state.k === "done" && (
        <p className="notice-ok">Appeal received. You will not see an individual outcome, but the number of reversed decisions is published in the integrity report.</p>
      )}
      {state.k === "error" && <p className="notice">{state.msg}</p>}
      <div>
        <button className="btn-primary" disabled={state.k === "working" || !entityId}>
          {state.k === "working" ? "Preparing your anonymous appeal…" : "Submit anonymous appeal"}
        </button>
      </div>
    </form>
  );
}

export default function AppealsPolicy() {
  return (
    <article className="container-page prose-civic max-w-3xl py-8">
      <h1 className="text-2xl font-bold">Fraud &amp; appeals policy</h1>
      <h2>Accept, but do not always count</h2>
      <p>
        To resist manipulation, GovZones may store a rating without counting it. Ratings that are on hold, held back or excluded count for nothing in any
        public number. We never tell you a rating “was counted” just because it was received.
      </p>
      <h2>What can lead to a rating not counting</h2>
      <ul>
        <li>The account has not yet passed our sign-up checks, for example because it is very new or shows signs of abuse. These checks never see your ratings.</li>
        <li>The rating is still within its 24-hour hold.</li>
        <li>We found signs of coordinated fake ratings. Several separate signs are needed, and a low score or criticism alone never counts as one.</li>
      </ul>
      <h2>What staff can and cannot do</h2>
      <ul>
        <li>Every decision has a case number, a record of the evidence, and a log of who did what.</li>
        <li>Staff cannot create, edit or move ratings, cannot link a rating to an account, and cannot hold back honest criticism for being negative.</li>
        <li>Government requests are handled only through proper legal process. Payments from agencies or positive scores are never treated as signs of trust.</li>
      </ul>
      <h2>Appeal anonymously</h2>
      <p>
        If you believe your genuine rating was wrongly held back, appeal using the anonymous receipt stored in your wallet. Reviewers look at the evidence
        again; they cannot ask for, and do not have, your identity.
      </p>
      <AppealTool />
      <p className="mt-4">
        Totals: <Link to="/ph/transparency">integrity &amp; transparency report</Link>.
      </p>
    </article>
  );
}
