import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, useNavigation, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/root";
import "./app.css";
import { webEnvContext } from "./lib/context";
import type { PublicConfig } from "./lib/config";
import { SiteHeader } from "./components/SiteHeader";
import { SiteFooter } from "./components/SiteFooter";
import { WalletProvider } from "./wallet/WalletContext";

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(webEnvContext);
  const config: PublicConfig = {
    environment: env.ENVIRONMENT,
    publicOrigin: env.PUBLIC_ORIGIN,
    accountsOrigin: env.ACCOUNTS_ORIGIN,
    voteOrigin: env.VOTE_ORIGIN,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? "",
    rootPublicKey: env.ROOT_PUBLIC_KEY,
  };
  return { config };
}

// Configuration never changes between navigations.
export function shouldRevalidate() {
  return false;
}

export const meta: Route.MetaFunction = () => [
  { title: "GovZones — Government offices, rated by the people" },
  {
    name: "description",
    content:
      "Search Philippine government agencies and offices and see transparent best- and lowest-rated rankings from anonymous 1–10 ratings. Independent; not a government website.",
  },
];

/** Thin top bar while a navigation or form submission is in flight. */
function NavigationProgress() {
  const nav = useNavigation();
  if (nav.state === "idle") return null;
  return (
    <div className="progress-bar" role="progressbar" aria-label="Loading">
      <span />
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData("root") as { config: PublicConfig } | undefined;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0b5c7a" />
        <meta name="color-scheme" content="light" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <Meta />
        {/* Stylesheets need no CSP nonce (style-src 'self'); an explicit empty nonce avoids a hydration
            mismatch, because browsers hide nonce values from the DOM after parsing. */}
        <Links nonce="" />
      </head>
      <body className="flex min-h-screen flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-paper focus:p-2">
          Skip to content
        </a>
        {data ? (
          <WalletProvider config={data.config}>
            <NavigationProgress />
            <SiteHeader environment={data.config.environment} />
            <main id="main" className="flex-1">
              {children}
            </main>
            <SiteFooter />
          </WalletProvider>
        ) : (
          <main id="main" className="flex-1">
            {children}
          </main>
        )}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let details = "Please try again in a moment.";
  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      title = "Page not found";
      details = "We couldn't find that page. It may have moved, or the listing may have been merged or renamed.";
    } else {
      details = error.statusText || details;
    }
  }
  return (
    <div className="container-page max-w-2xl py-16 text-center">
      <p className="eyebrow">{isRouteErrorResponse(error) ? `Error ${error.status}` : "Error"}</p>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{title}</h1>
      <p className="mt-3 text-muted">{details}</p>
      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <a className="btn-primary" href="/ph">
          Go to the homepage
        </a>
        <a className="btn-secondary" href="/ph/search">
          Search the directory
        </a>
      </div>
    </div>
  );
}
