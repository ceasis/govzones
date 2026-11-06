import { useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/me.account";
import { useConfig } from "../lib/config";
import { useWallet } from "../wallet/WalletContext";

export const meta: Route.MetaFunction = () => [{ title: "Account · GovZones" }, { name: "robots", content: "noindex" }];

export default function Account() {
  const cfg = useConfig();
  const { session, wallet, refreshSession } = useWallet();
  const [phrase, setPhrase] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const active = wallet ? Object.values(wallet.ratings).filter((r) => r.status === "submitted").length : 0;
  const pendingDeletes = wallet ? Object.values(wallet.pending).filter((p) => p.operation === "DELETE").length : 0;

  if (session === null) return <div className="container-page py-8">Loading…</div>;
  if (deleted) {
    return (
      <div className="container-page max-w-2xl py-8">
        <h1 className="text-2xl font-bold">Account deleted</h1>
        <p className="mt-2">Your account, sign-in sessions, voting pass registration and locked backup have been deleted.</p>
        <p className="mt-2 text-sm text-muted">
          Anonymous ratings you did not delete beforehand remain, because by design nobody, including GovZones, can link them to your account.
        </p>
      </div>
    );
  }
  if (!session.signedIn) {
    return (
      <div className="container-page max-w-2xl py-8">
        <h1 className="text-2xl font-bold">Account</h1>
        <p className="mt-2 text-muted">You are not signed in.</p>
        <Link className="btn-primary mt-4" to="/sign-in">
          Sign in
        </Link>
      </div>
    );
  }

  const call = async (path: string, method: "POST" | "DELETE", body?: unknown) => {
    const { accountsCall } = await import("../wallet/clients");
    return accountsCall(cfg, path, method, body);
  };

  return (
    <div className="container-page max-w-2xl space-y-6 py-8">
      <h1 className="text-2xl font-bold">Account</h1>
      {msg && (
        <p className="notice" role="status">
          {msg}
        </p>
      )}

      <section className="card space-y-2" aria-labelledby="signout-h">
        <h2 id="signout-h" className="text-lg font-bold">
          Sign out
        </h2>
        <p className="text-sm text-muted">Signing out does not remove your voting wallet from this device. You can still update ratings later.</p>
        <button
          className="btn-secondary"
          onClick={async () => {
            await call("/auth/logout", "POST");
            await refreshSession();
            setMsg("Signed out.");
          }}
        >
          Sign out
        </button>
      </section>

      <section className="card space-y-2" aria-labelledby="reset-h">
        <h2 id="reset-h" className="text-lg font-bold">
          Lost your wallet and recovery key?
        </h2>
        <p className="text-sm text-muted">
          You can ask for a voting pass reset. Staff review it; if approved, your old pass is cancelled and you may set up a new one. Your old anonymous
          ratings cannot be found or removed, so ratings from a reset pass are not counted in public scores for 12 months, to prevent double-counting.
        </p>
        {session.resetRequests?.some((r) => r.status === "PENDING") ? (
          <p className="notice">A reset request is pending review.</p>
        ) : (
          <button
            className="btn-secondary"
            onClick={async () => {
              await call("/api/v1/wallet/reset-request", "POST", { country: "PH" });
              await refreshSession();
              setMsg("Reset request sent for review.");
            }}
          >
            Request voting pass reset
          </button>
        )}
      </section>

      <section className="card space-y-3" aria-labelledby="delete-h">
        <h2 id="delete-h" className="text-lg font-bold">
          Delete account
        </h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            <strong>Delete your anonymous ratings first</strong> (while this device's wallet can still prove they are yours). Deleting the account alone cannot
            locate them.{" "}
            {wallet ? (
              active > 0 ? (
                <Link className="link" to="/me/ratings">
                  You have {active} active rating(s): delete them on My ratings
                </Link>
              ) : (
                <span>No active ratings in this wallet{pendingDeletes ? ` (${pendingDeletes} deletion(s) still queued)` : ""}.</span>
              )
            ) : (
              <span>No wallet on this device. Restore it first if you want to delete your ratings.</span>
            )}
          </li>
          <li>Then delete the account. This cancels your voting pass, ends all sign-in sessions and deletes your locked backup.</li>
        </ol>
        <p className="notice">
          After deletion, signing in again with the same e-mail address creates a new account whose ratings are not counted for 12 months, because
          earlier anonymous ratings may still exist.
        </p>
        <div>
          <label className="label" htmlFor="del-phrase">
            Type DELETE MY ACCOUNT to confirm
          </label>
          <input id="del-phrase" className="field" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" />
        </div>
        <button
          className="btn-danger"
          disabled={phrase !== "DELETE MY ACCOUNT"}
          onClick={async () => {
            try {
              await call("/api/v1/me", "DELETE", { confirm: phrase });
              await refreshSession();
              setDeleted(true);
            } catch (e) {
              setMsg(e instanceof Error ? e.message : "Could not delete the account.");
            }
          }}
        >
          Delete my account
        </button>
      </section>
    </div>
  );
}
