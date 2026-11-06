import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/me.wallet";
import { useConfig } from "../lib/config";
import { jitter, useWallet } from "../wallet/WalletContext";
import { INTENT_KEY, type RateIntent } from "../components/RatePanel";

export const meta: Route.MetaFunction = () => [{ title: "Your voting wallet · GovZones" }, { name: "robots", content: "noindex" }];

const COUNTRY = "PH";

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function readIntent(): RateIntent | null {
  try {
    return JSON.parse(sessionStorage.getItem(INTENT_KEY) ?? "null");
  } catch {
    return null;
  }
}

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string };
  }
}

function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!siteKey) return;
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => ref.current && window.turnstile?.render(ref.current, { sitekey: siteKey, callback: onToken });
    document.head.appendChild(s);
    return () => {
      s.remove();
    };
  }, [siteKey, onToken]);
  return siteKey ? <div ref={ref} className="min-h-16" /> : null;
}

/** Step-by-step credential creation: explain → save recovery key → enroll public commitment → optional encrypted backup. */
function CreateWallet({ onDone, resume = false }: { onDone: () => void; resume?: boolean }) {
  const cfg = useConfig();
  const { reload, refreshSession } = useWallet();
  // `resume`: the wallet (and its recovery key) already exists on this device; only registration is left.
  const [step, setStep] = useState<"explain" | "key" | "enroll" | "done">(resume ? "enroll" : "explain");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [backupToAccount, setBackupToAccount] = useState(true);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    const { generateRecoveryKey } = await import("../wallet/crypto");
    setRecoveryKey(generateRecoveryKey());
    setStep("key");
  };

  const enroll = async () => {
    setBusy(true);
    setError(null);
    try {
      const [{ Identity }, wallet, { accountsCall }] = await Promise.all([
        import("@semaphore-protocol/identity"),
        import("../wallet/wallet"),
        import("../wallet/clients"),
      ]);
      const w = (await wallet.loadWallet()) ?? (await wallet.createWallet(recoveryKey));
      let id = w.identities[COUNTRY];
      if (!id) {
        // Random identity from the audited Semaphore library; never derived from your account.
        const identity = new Identity();
        id = { privateKey: identity.export(), commitment: identity.commitment.toString(), enrolled: false };
        w.identities[COUNTRY] = id;
        w.recoveryConfirmed = true;
        await wallet.saveWallet(w);
      }
      // Only the PUBLIC commitment is sent to the account host.
      await accountsCall(cfg, "/api/v1/wallet/enroll", "POST", { country: COUNTRY, commitment: id.commitment, turnstileToken: token || undefined });
      w.identities[COUNTRY].enrolled = true;
      await wallet.saveWallet(w);
      if (backupToAccount) {
        const ciphertext = await wallet.exportBackup(w);
        await accountsCall(cfg, "/api/v1/wallet/backup", "PUT", { ciphertext, version: w.backup.version + 1 });
        w.backup = { version: w.backup.version + 1, dirty: false, lastUploadedDay: new Date().toISOString().slice(0, 10) };
        await wallet.saveWallet(w);
      }
      await reload();
      await refreshSession();
      setStep("done");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Activation failed.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "explain") {
    return (
      <section className="card space-y-3" aria-labelledby="create-h">
        <h2 id="create-h" className="text-lg font-bold">
          Create your private voting pass
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>A random, private voting pass is created on this device. It never leaves your device unlocked.</li>
          <li>Only a public code made from it is registered to your account, so each account has one voting pass.</li>
          <li>When you rate, your device shows that it holds a valid voting pass without revealing which one. Your login is not sent with ratings.</li>
          <li>
            You'll get a <strong>recovery key</strong>. You need it to update or delete your ratings on another device or after clearing your browser.
          </li>
        </ul>
        <button className="btn-primary" onClick={start}>
          Continue
        </button>
      </section>
    );
  }
  if (step === "key") {
    const lastGroup = recoveryKey.slice(-4);
    return (
      <section className="card space-y-3" aria-labelledby="key-h">
        <h2 id="key-h" className="text-lg font-bold">
          Save your recovery key
        </h2>
        <p className="text-sm">
          Write it down or store it in a password manager. GovZones cannot show it again or recover it for you. Signing in by e-mail does not replace
          it.
        </p>
        <p className="select-all break-all rounded-lg border-2 border-dashed border-ink/40 bg-slate-50 p-3 text-center font-mono text-lg font-bold tracking-wider" aria-label="Recovery key">
          {recoveryKey}
        </p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={() => navigator.clipboard?.writeText(recoveryKey)}>
            Copy
          </button>
          <button className="btn-secondary" onClick={() => download("govzones-recovery-key.txt", `GovZones recovery key\n${recoveryKey}\n`)}>
            Download as text file
          </button>
        </div>
        <p className="notice">
          If you lose <strong>both</strong> this device's wallet and your recovery key, you will not be able to edit or delete your earlier anonymous
          ratings. That is the price of real anonymity: nobody, including GovZones, can link them back to you.
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 size-5" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have saved my recovery key somewhere safe.
        </label>
        <div>
          <label className="label" htmlFor="confirm-key">
            Type the last four characters of your recovery key to confirm
          </label>
          <input id="confirm-key" className="field max-w-[10rem] font-mono uppercase" maxLength={4} value={confirm} onChange={(e) => setConfirm(e.target.value.toUpperCase())} />
        </div>
        <button className="btn-primary" disabled={!saved || confirm !== lastGroup} onClick={() => setStep("enroll")}>
          Continue
        </button>
      </section>
    );
  }
  return (
    <section className="card space-y-3" aria-labelledby="enroll-h">
      <h2 id="enroll-h" className="text-lg font-bold">
        Activate your voting pass
      </h2>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1 size-5" checked={backupToAccount} onChange={(e) => setBackupToAccount(e.target.checked)} />
        <span>
          Keep a locked backup with my account. Only your recovery key can open it; GovZones cannot read it. Without it, you'll need the downloaded
          backup file to restore on another device.
        </span>
      </label>
      <Turnstile siteKey={cfg.turnstileSiteKey} onToken={setToken} />
      {error && <p className="notice">{error}</p>}
      <button className="btn-primary" disabled={busy || (Boolean(cfg.turnstileSiteKey) && !token)} onClick={enroll}>
        {busy ? "Activating…" : "Activate voting pass"}
      </button>
    </section>
  );
}

function Restore({ fromAccount }: { fromAccount: boolean }) {
  const cfg = useConfig();
  const { reload } = useWallet();
  const [key, setKey] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card space-y-3"
      onSubmit={async (ev) => {
        ev.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const [{ normalizeRecoveryKey }, wallet, { accountsCall }] = await Promise.all([
            import("../wallet/crypto"),
            import("../wallet/wallet"),
            import("../wallet/clients"),
          ]);
          const rk = normalizeRecoveryKey(key);
          if (!rk) throw new Error("That doesn't look like a recovery key (32 characters).");
          const envelope = file ?? (await accountsCall<{ ciphertext: string }>(cfg, "/api/v1/wallet/backup", "GET")).ciphertext;
          await wallet.restoreFromBackup(envelope, rk);
          await reload();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Restore failed.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="text-lg font-bold">Restore your wallet</h2>
      <p className="text-sm text-muted">
        {fromAccount ? "Use the locked backup stored with your account, or a backup file." : "Use a GovZones backup file."} Your recovery key unlocks it on
        this device only.
      </p>
      <div>
        <label className="label" htmlFor="rk">
          Recovery key
        </label>
        <input id="rk" className="field font-mono uppercase" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" />
      </div>
      <div>
        <label className="label" htmlFor="bf">
          Backup file {fromAccount ? "(optional)" : ""}
        </label>
        <input id="bf" type="file" className="field" accept=".govzones,.txt,application/octet-stream" onChange={async (e) => setFile((await e.target.files?.[0]?.text()) ?? null)} />
      </div>
      {error && <p className="notice">{error}</p>}
      <button className="btn-primary" disabled={busy || (!fromAccount && !file)}>
        {busy ? "Restoring…" : "Restore"}
      </button>
    </form>
  );
}

export default function WalletPage() {
  const cfg = useConfig();
  const { status, wallet, session, update, queue } = useWallet();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [msg, setMsg] = useState<string | null>(null);
  const continuing = params.get("continue") === "1";
  const identity = wallet?.identities[COUNTRY];
  const accountCommitment = session?.enrollments?.find((e) => e.country === COUNTRY)?.commitment;

  // Enrollment may have succeeded server-side even if the response was lost: reconcile.
  useEffect(() => {
    if (identity && !identity.enrolled && accountCommitment === identity.commitment) {
      void update((w) => {
        if (w.identities[COUNTRY]) w.identities[COUNTRY].enrolled = true;
      });
    }
  }, [identity, accountCommitment, update]);

  // After sign-in/enrollment, resume the rating the user started (kept only in this tab).
  useEffect(() => {
    if (!continuing || !identity?.enrolled) return;
    const intent = readIntent();
    if (!intent) return;
    sessionStorage.removeItem(INTENT_KEY);
    void queue(
      { entityId: intent.entityId, country: intent.country, name: intent.name, path: intent.path, operation: "UPSERT", score: intent.score },
      jitter(8_000, 40_000),
    ).then(() => navigate(intent.path));
  }, [continuing, identity?.enrolled, queue, navigate]);

  if (status === "loading" || session === null) return <div className="container-page py-8">Loading your wallet…</div>;

  return (
    <div className="container-page max-w-2xl space-y-6 py-8">
      <div>
        <h1 className="text-2xl font-bold">Your voting wallet</h1>
        <p className="mt-1 text-muted">Kept locked in this browser. It holds your private voting pass and your own list of ratings.</p>
      </div>

      {!wallet && !session.signedIn && (
        <>
          <div className="card space-y-2">
            <p>To create a voting pass, sign in first.</p>
            <Link className="btn-primary" to="/sign-in">
              Sign in
            </Link>
          </div>
          <Restore fromAccount={false} />
        </>
      )}

      {!wallet && session.signedIn && (accountCommitment ? <AlreadyEnrolled hasBackup={Boolean(session.backup)} /> : <CreateWallet onDone={() => undefined} />)}

      {wallet && (
        <>
          {identity && !identity.enrolled && session.signedIn && !accountCommitment && <CreateWallet resume onDone={() => undefined} />}
          {identity && accountCommitment && accountCommitment !== identity.commitment && (
            <p className="notice">
              The account you are signed in to has a different voting pass than this device's wallet. Sign in with the account that created this wallet,
              or restore that account's wallet.
            </p>
          )}
          <section className="card space-y-2" aria-labelledby="status-h">
            <h2 id="status-h" className="text-lg font-bold">
              Status
            </h2>
            <p className="text-sm">
              Voting pass for the Philippines: <strong>{identity ? (identity.enrolled ? "registered" : "not registered yet") : "none"}</strong>.{" "}
              {Object.values(wallet.ratings).filter((r) => r.status === "submitted").length} active rating(s),{" "}
              {Object.keys(wallet.pending).length} waiting to be sent.
            </p>
            <p className="text-xs text-muted">
              New voting passes are activated in groups (to protect anonymity), so it can take up to about an hour before you can rate.
            </p>
            <Link className="btn-secondary" to="/me/ratings">
              View my ratings
            </Link>
          </section>
          <section className="card space-y-3" aria-labelledby="backup-h">
            <h2 id="backup-h" className="text-lg font-bold">
              Backup
            </h2>
            <p className="text-sm text-muted">
              {wallet.backup.lastUploadedDay ? `Account backup last updated ${wallet.backup.lastUploadedDay}.` : "No account backup uploaded from this device."}{" "}
              {wallet.backup.dirty ? "Your wallet has changed since the last backup." : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              {session.signedIn && (
                <button
                  className="btn-secondary"
                  onClick={async () => {
                    try {
                      const [{ exportBackup }, { accountsCall }] = await Promise.all([import("../wallet/wallet"), import("../wallet/clients")]);
                      const ciphertext = await exportBackup(wallet);
                      await accountsCall(cfg, "/api/v1/wallet/backup", "PUT", { ciphertext, version: wallet.backup.version + 1 });
                      await update((w) => (w.backup = { version: w.backup.version + 1, dirty: false, lastUploadedDay: new Date().toISOString().slice(0, 10) }));
                      setMsg("Locked backup saved to your account.");
                    } catch (e) {
                      setMsg(e instanceof Error ? e.message : "Backup failed.");
                    }
                  }}
                >
                  Save locked backup to account
                </button>
              )}
              <button
                className="btn-secondary"
                onClick={async () => {
                  const { exportBackup } = await import("../wallet/wallet");
                  download(`govzones-wallet-${new Date().toISOString().slice(0, 10)}.govzones`, await exportBackup(wallet));
                  setMsg("Backup file downloaded. It can only be opened with your recovery key.");
                }}
              >
                Download backup file
              </button>
            </div>
            {msg && (
              <p className="notice-ok" role="status">
                {msg}
              </p>
            )}
          </section>
          <section className="card space-y-2" aria-labelledby="remove-h">
            <h2 id="remove-h" className="text-lg font-bold">
              Remove from this device
            </h2>
            <p className="text-sm text-muted">
              Removes the wallet from this browser only. Your ratings stay as they are. Make sure you have your recovery key and a backup first.
            </p>
            <button
              className="btn-danger"
              onClick={async () => {
                if (!window.confirm("Remove the voting wallet from this browser? You will need your recovery key and a backup to restore it.")) return;
                const { forgetWallet } = await import("../wallet/wallet");
                await forgetWallet();
                window.location.reload();
              }}
            >
              Remove wallet from this device
            </button>
          </section>
        </>
      )}
    </div>
  );
}

function AlreadyEnrolled({ hasBackup }: { hasBackup: boolean }) {
  return (
    <>
      <p className="notice">
        This account already has a voting pass, created on another device or before your browser data was cleared. Restore it with your recovery key.
        For your safety, GovZones never silently creates a second voting pass for the same account.
      </p>
      <Restore fromAccount={hasBackup} />
      <p className="text-sm text-muted">
        Lost your recovery key and backup?{" "}
        <Link className="link" to="/me/account">
          Request a voting pass reset
        </Link>{" "}
        (reviewed by staff; ratings from a reset pass are not counted for a long period, because old ratings cannot be found and removed).
      </p>
    </>
  );
}
