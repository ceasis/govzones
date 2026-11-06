import type { EntryContext, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { webEnvContext } from "./lib/context";

export const streamTimeout = 5_000;

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function contentSecurityPolicy(n: string, opts: { accounts: string; vote: string; dev: boolean; turnstile: boolean }) {
  const turnstile = opts.turnstile ? " https://challenges.cloudflare.com" : "";
  const devSockets = opts.dev ? " ws://govzones.localhost:5173 ws://localhost:5173 ws://127.0.0.1:5173" : "";
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets the in-browser Semaphore prover compile its pinned WebAssembly.
    `script-src 'self' 'nonce-${n}' 'wasm-unsafe-eval'${turnstile}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${opts.accounts} ${opts.vote}${devSockets}`,
    "worker-src 'self' blob:",
    `frame-src${turnstile || " 'none'"}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    `form-action 'self' ${opts.accounts}`,
    "object-src 'none'",
  ].join("; ");
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  const { env } = loadContext.get(webEnvContext);
  const n = nonce();
  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(<ServerRouter context={routerContext} url={request.url} nonce={n} />, {
    nonce: n,
    onError(error: unknown) {
      responseStatusCode = 500;
      if (shellRendered) console.error("render_error", error instanceof Error ? error.message : "unknown");
    },
  });
  shellRendered = true;

  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) await body.allReady;

  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  responseHeaders.set(
    "Content-Security-Policy",
    contentSecurityPolicy(n, {
      accounts: env.ACCOUNTS_ORIGIN,
      vote: env.VOTE_ORIGIN,
      dev: env.ENVIRONMENT === "development",
      turnstile: Boolean(env.TURNSTILE_SITE_KEY),
    }),
  );
  // No Referer leaves GovZones pages: the ballot and account hosts never learn which page you were on.
  responseHeaders.set("Referrer-Policy", "no-referrer");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("X-Frame-Options", "DENY");
  responseHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
  responseHeaders.set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), interest-cohort=()");
  if (env.ENVIRONMENT === "production") {
    responseHeaders.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  } else {
    responseHeaders.set("X-Robots-Tag", "noindex, nofollow");
  }
  if (!responseHeaders.has("Cache-Control")) responseHeaders.set("Cache-Control", "private, no-store");

  return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
