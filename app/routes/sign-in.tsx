import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/sign-in";
import { useConfig } from "../lib/config";
import { useWallet } from "../wallet/WalletContext";

export const meta: Route.MetaFunction = () => [{ title: "Sign in · GovZones" }, { name: "robots", content: "noindex" }];

const RESEND_SECONDS = 30;

/**
 * E-mail one-time code, both steps on this page (no redirect to the account host). The account
 * host receives the address only to send the code; it is never told which agency you were rating.
 */
export default function SignIn() {
  const cfg = useConfig();
  const { session, refreshSession } = useWallet();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const { requestEmailCode } = await import("../wallet/clients");
      const r = await requestEmailCode(cfg, email);
      setDevCode(r.devCode ?? null);
      setCode("");
      setStep("code");
      setResendIn(RESEND_SECONDS);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const { verifyEmailCode } = await import("../wallet/clients");
      await verifyEmailCode(cfg, email, code);
      await refreshSession();
      navigate("/me/wallet?continue=1");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in.");
      setBusy(false);
    }
  };

  return (
    <div className="container-page max-w-xl py-8">
      <h1 className="text-2xl font-bold">Sign in to rate</h1>
      <p className="mt-2 text-muted">
        Browsing, searching and rankings never need an account. You only need to sign in once, to set up a private voting pass on this device.
      </p>

      <div className="card mt-6">
        {session?.signedIn ? (
          <div className="space-y-3">
            <p className="notice-ok">You are signed in.</p>
            <Link to="/me/wallet?continue=1" className="btn-primary w-full">
              Continue
            </Link>
          </div>
        ) : step === "email" ? (
          <form
            className="space-y-3"
            onSubmit={(ev) => {
              ev.preventDefault();
              void sendCode();
            }}
          >
            <label className="label" htmlFor="email">
              Your e-mail address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              maxLength={254}
              className="field"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="text-sm text-muted">We'll e-mail you a 6-digit code. No password to remember.</p>
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            <button className="btn-primary w-full" disabled={busy || !email}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(ev) => {
              ev.preventDefault();
              void verify();
            }}
          >
            <p className="text-sm">
              We sent a code to <strong className="break-all">{email}</strong>.{" "}
              <button type="button" className="link" onClick={() => (setStep("email"), setError(null))}>
                Use a different address
              </button>
            </p>
            {devCode && (
              <p className="notice text-sm">
                Local development: your code is <strong data-dev-code>{devCode}</strong> (no e-mail is sent).
              </p>
            )}
            <label className="label" htmlFor="code">
              6-digit code
            </label>
            <input
              ref={codeRef}
              id="code"
              name="code"
              inputMode="numeric"
              pattern="[0-9 ]*"
              autoComplete="one-time-code"
              required
              maxLength={7}
              className="field text-center font-mono text-2xl tracking-[0.4em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
            />
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            <button className="btn-primary w-full" disabled={busy || code.length !== 6}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <p className="text-sm text-muted">
              Didn't get it? Check your spam folder, or{" "}
              <button type="button" className="link disabled:no-underline disabled:opacity-60" disabled={busy || resendIn > 0} onClick={() => void sendCode()}>
                {resendIn > 0 ? `resend in ${resendIn} s` : "send a new code"}
              </button>
              . Codes expire after 10 minutes.
            </p>
          </form>
        )}
      </div>

      <section className="prose-civic mt-6 text-sm" aria-labelledby="what-h">
        <h2 id="what-h">What signing in does — and doesn't do</h2>
        <ul>
          <li>
            We use your address once, to send the code. We keep only a scrambled version of it, not the address itself, so our account list can never
            become a mailing list. We never send newsletters or marketing.
          </li>
          <li>Each address can hold one voting pass, which stops one person from rating the same office many times.</li>
          <li>
            Your ratings are <strong>not</strong> sent with your login. They go to a separate service that receives no cookies and cannot tell who sent
            them.
          </li>
          <li>There are no public profiles. Nothing you rate is ever shown next to your name or address.</li>
        </ul>
        <p>
          <Link to="/about">How anonymity works, including its limits</Link>
        </p>
      </section>
    </div>
  );
}
