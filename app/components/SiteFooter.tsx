import { Link } from "react-router";
import { BrandMark } from "./SiteHeader";

const COLUMNS: Array<{ title: string; links: Array<[string, string]> }> = [
  {
    title: "Explore",
    links: [
      ["/ph/rankings", "Rankings"],
      ["/ph/search", "Search the directory"],
      ["/ph/places", "Browse by place"],
      ["/ph/suggest", "Suggest a missing office"],
    ],
  },
  {
    title: "Understand",
    links: [
      ["/ph/methodology", "How scores work"],
      ["/about", "How anonymity works"],
      ["/ph/transparency", "Integrity report"],
    ],
  },
  {
    title: "Policies",
    links: [
      ["/privacy", "Privacy notice"],
      ["/terms", "Terms of use"],
      ["/policies/corrections", "Directory corrections"],
      ["/policies/appeals", "Fraud & appeals"],
      ["/countries", "Country: Philippines"],
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line bg-paper">
      <div className="container-page grid gap-8 py-10 text-sm sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <p className="flex items-center gap-2 text-base font-extrabold tracking-tight">
            <BrandMark className="size-7" /> GovZones
          </p>
          <p className="mt-2 text-muted">Government offices, rated by the people.</p>
          <p className="mt-3 text-muted">
            An independent public-feedback website. <strong className="text-ink">Not</strong> a government service, not endorsed by any agency, and not a
            statistical survey. Ratings are people's own perceptions, not official performance audits.
          </p>
        </div>
        {COLUMNS.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <p className="eyebrow mb-2">{col.title}</p>
            <ul className="flex flex-col">
              {col.links.map(([to, label]) => (
                <li key={to}>
                  <Link className="link-plain inline-block py-1.5" to={to}>
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-line">
        <div className="container-page flex flex-wrap items-center justify-between gap-2 py-4 text-xs text-muted">
          <p>No paid placement. No reputation clean-up. Nobody can see who rated what.</p>
          <p>© {new Date().getFullYear()} GovZones</p>
        </div>
      </div>
    </footer>
  );
}
