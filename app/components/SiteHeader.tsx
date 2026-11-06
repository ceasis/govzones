import { Link, NavLink } from "react-router";
import { useWallet } from "../wallet/WalletContext";

export function BrandMark({ className = "size-8" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className={`${className} shrink-0`}>
      <rect width="32" height="32" rx="8" fill="var(--color-accent)" />
      <path d="M9 17l4.5 4.5L23 12" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const NAV = [
  ["/ph/rankings", "Rankings"],
  ["/ph/search", "Search"],
  ["/ph/places", "Places"],
  ["/ph/methodology", "How it works"],
] as const;

/** Sticky, translucent header. The account control has a fixed width so hydration causes no layout shift. */
export function SiteHeader({ environment }: { environment: string }) {
  const { session, status } = useWallet();
  const signedIn = session?.signedIn === true;
  const hasWallet = status === "ready";
  const accountLabel = signedIn || hasWallet ? "My ratings" : "Sign in";
  const accountHref = signedIn || hasWallet ? "/me/ratings" : "/sign-in";

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/90 backdrop-blur supports-[backdrop-filter]:bg-paper/80">
      {environment !== "production" && (
        <p className="bg-gold-soft px-4 py-1 text-center text-xs font-semibold text-gold">
          {environment === "development"
            ? "Local development environment — test data only"
            : environment === "preview"
              ? "Temporary preview — test data only; ratings here are not real"
              : "Staging environment — not the live site"}
        </p>
      )}
      <div className="container-page flex min-h-14 items-center gap-2 py-2 sm:gap-3">
        <Link to="/ph" className="mr-auto flex min-h-11 min-w-0 items-center gap-2 font-extrabold tracking-tight text-ink">
          <BrandMark />
          <span className="text-lg">GovZones</span>
          <span className="hidden rounded-md border border-line px-1.5 text-xs font-semibold text-muted min-[400px]:inline" title="Philippines">
            PH
          </span>
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV.map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `btn px-3 text-sm font-semibold ${isActive ? "bg-accent-soft text-accent-strong" : "text-ink hover:bg-accent-soft"}`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <Link to={accountHref} className="btn-secondary w-24 shrink-0 px-2 text-sm sm:w-[7.5rem]" aria-live="polite">
          {accountLabel}
        </Link>
        <details className="relative md:hidden">
          <summary className="btn-secondary cursor-pointer list-none px-0 [&::-webkit-details-marker]:hidden" aria-label="Menu">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </summary>
          <nav aria-label="Mobile" className="absolute right-0 z-20 mt-2 flex w-60 flex-col rounded-2xl border border-line bg-paper p-2 shadow-[var(--shadow-lift)]">
            {[["/ph", "Home"], ...NAV, ["/me/ratings", "My ratings"], ["/countries", "Change country"]].map(([to, label]) => (
              <Link key={to} className="btn justify-start text-sm font-semibold hover:bg-accent-soft" to={to}>
                {label}
              </Link>
            ))}
          </nav>
        </details>
      </div>
    </header>
  );
}
