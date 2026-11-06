import { Link } from "react-router";
import type { Route } from "./+types/home";
import { envFrom, requireCountry } from "../lib/route.server";
import { directoryCounts, geoChildren, rankings, recentlyAdded } from "../lib/data.server";
import { pageMeta } from "../lib/meta";
import { SearchBox } from "../components/SearchBox";
import { RankingList } from "../components/RankingList";
import { EntityCard } from "../components/EntityCard";
import { SCORING, countedRatings } from "../../shared/scoring";

export async function loader({ context, params }: Route.LoaderArgs) {
  const country = await requireCountry(context, params.country);
  const env = envFrom(context);
  const base = { cohort: "AGENCY" as const, period: "12m" as const, limit: 5 };
  const [best, lowest, most, recent, counts, regions] = await Promise.all([
    rankings(env.PUBLIC_CACHE, country.code, { ...base, kind: "best" }),
    rankings(env.PUBLIC_CACHE, country.code, { ...base, kind: "lowest" }),
    rankings(env.PUBLIC_CACHE, country.code, { ...base, cohort: "mixed", kind: "most" }),
    recentlyAdded(env.DIRECTORY, country.code, 4),
    directoryCounts(env.DIRECTORY, country.code),
    geoChildren(env.DIRECTORY, country.code, null, "REGION"),
  ]);
  return { country, best, lowest, most, recent, counts, regions, origin: env.PUBLIC_ORIGIN };
}

export const meta: Route.MetaFunction = ({ loaderData }) =>
  pageMeta({
    title: "GovZones Philippines — Government offices, rated by the people",
    description: "Search Philippine government agencies and offices and see how the public rates them, 1 to 10. Anonymous ratings, transparent rankings, no sign-in needed to browse.",
    origin: loaderData?.origin,
    path: "/ph",
  });

const n = (v: number) => v.toLocaleString("en");

function EmptyRanking({ which }: { which: "best" | "lowest" }) {
  return (
    <div className="card-flat text-sm">
      <p className="font-semibold">No national agency has been rated yet.</p>
      <p className="mt-1 text-muted">
        An agency appears in {which === "best" ? "Best Rated" : "Lowest Rated"} as soon as it has {countedRatings(SCORING.minRankingVotes)} in the last 12
        months. We never fill these lists with made-up results.
      </p>
    </div>
  );
}

function SectionHead({ id, title, eyebrow, href, hrefLabel }: { id: string; title: string; eyebrow: string; href?: string; hrefLabel?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={id} className="section-title">
          {title}
        </h2>
      </div>
      {href && (
        <Link to={href} className="link text-sm font-semibold">
          {hrefLabel} →
        </Link>
      )}
    </div>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { best, lowest, most, recent, counts, regions } = loaderData;
  const period = "Last 12 months";
  return (
    <>
      <section className="hero-band">
        <div className="container-page py-10 sm:py-16">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-white/75">Philippines · Independent · Anonymous</p>
          <h1 className="mt-2 max-w-3xl text-3xl font-extrabold leading-[1.1] tracking-tight sm:text-5xl">Government offices, rated by the people.</h1>
          <p className="mt-4 max-w-2xl text-base text-white/85 sm:text-lg">
            Find any Philippine agency, city hall or service office and see how people who used it rate it, from 1 (very poor) to 10 (excellent). No
            sign-in needed to browse.
          </p>
          <div className="mt-6 max-w-2xl">
            <SearchBox variant="hero" />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link className="chip-dark" to="/ph/search?scope=national">
              National agencies
            </Link>
            <Link className="chip-dark" to="/ph/search?scope=local">
              Local government
            </Link>
            <Link className="chip-dark" to="/ph/search?scope=offices">
              Service offices
            </Link>
            <Link className="chip-dark" to="/ph/places">
              Browse by place
            </Link>
          </div>
        </div>
      </section>

      <section aria-label="Directory at a glance" className="container-page -mt-6 sm:-mt-8">
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <li className="stat">
            <p className="stat-value">{n(counts.total)}</p>
            <p className="stat-label">listings</p>
          </li>
          <li className="stat">
            <p className="stat-value">{n(counts.places)}</p>
            <p className="stat-label">regions, provinces &amp; cities</p>
          </li>
          <li className="stat">
            <p className="stat-value">{n(counts.counted12m)}</p>
            <p className="stat-label">ratings counted, last 12 months</p>
          </li>
          <li className="stat">
            <p className="stat-value">{n(counts.rated12m)}</p>
            <p className="stat-label">offices with a public score</p>
          </li>
        </ul>
      </section>

      <div className="container-page mt-12 grid gap-10 md:grid-cols-2">
        <section aria-labelledby="best-h">
          <SectionHead id="best-h" eyebrow={`National agencies · ${period}`} title="Best Rated" href="/ph/rankings?kind=best" hrefLabel="Full ranking" />
          {best.rows.length ? <RankingList rows={best.rows} periodLabel={period} /> : <EmptyRanking which="best" />}
        </section>
        <section aria-labelledby="lowest-h">
          <SectionHead id="lowest-h" eyebrow={`National agencies · ${period}`} title="Lowest Rated" href="/ph/rankings?kind=lowest" hrefLabel="Full ranking" />
          {lowest.rows.length ? <RankingList rows={lowest.rows} periodLabel={period} /> : <EmptyRanking which="lowest" />}
          <p className="mt-2 text-xs text-muted">Lowest rated by users among rated agencies. Not an official finding.</p>
        </section>
      </div>

      <div className="container-page mt-12 grid gap-10 md:grid-cols-2">
        <section aria-labelledby="most-h">
          <SectionHead id="most-h" eyebrow={`All listing types · ${period}`} title="Most Rated" href="/ph/rankings?kind=most&type=mixed" hrefLabel="See more" />
          {most.rows.length ? (
            <RankingList rows={most.rows} periodLabel={period} showQualification />
          ) : (
            <p className="card-flat text-sm text-muted">No ratings have been counted yet. Be among the first to rate an office you have used.</p>
          )}
        </section>
        <section aria-labelledby="recent-h">
          <SectionHead id="recent-h" eyebrow="Directory" title="Recently added" href="/ph/suggest" hrefLabel="Suggest a missing office" />
          <ul className="space-y-2">
            {recent.map((e) => (
              <EntityCard key={e.id} entity={e} />
            ))}
          </ul>
          <p className="mt-3 text-sm text-muted">
            {n(counts.national)} national bodies, {n(counts.lgus)} local governments and {n(counts.offices)} service offices so far; {n(counts.verified)} checked
            against official sources. The directory is still growing.
          </p>
        </section>
      </div>

      <section aria-labelledby="regions-h" className="container-page mt-12">
        <SectionHead id="regions-h" eyebrow="Browse" title="By region" href="/ph/places" hrefLabel="All places" />
        <ul className="flex flex-wrap gap-2">
          {regions.map((r) => (
            <li key={r.id}>
              <Link className="chip" to={`/ph/places/${r.id}`}>
                {r.shortName ?? r.name}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="how-h" className="container-page mt-14">
        <p className="eyebrow">How it works</p>
        <h2 id="how-h" className="section-title">
          One honest rating per person, per office
        </h2>
        <ol className="mt-4 grid gap-4 md:grid-cols-3">
          {[
            ["Find the office you used", "Search by name, abbreviation or place. Agencies, city halls and individual service offices are listed and rated separately."],
            ["Rate it 1 to 10", "A whole number, nothing else: no reviews, photos or comments. You can change it once every 30 days or delete it any time."],
            ["It counts, anonymously", "Your rating is sent without your login, so nobody can see who rated what. It is checked and held for 24 hours, then counted."],
          ].map(([title, body], i) => (
            <li key={title} className="card">
              <span className="grid size-9 place-items-center rounded-full bg-accent text-sm font-extrabold text-accent-ink" aria-hidden="true">
                {i + 1}
              </span>
              <h3 className="mt-3 font-bold">{title}</h3>
              <p className="mt-1 text-sm text-muted">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="Trust" className="container-page mt-10">
        <div className="card-flat grid gap-6 md:grid-cols-3">
          <div>
            <h2 className="font-bold">Simple, open scoring</h2>
            <p className="mt-1 text-sm text-muted">
              Scores are the simple average of counted ratings. Rankings compare offices of the same kind, and a listing with only a few ratings stays
              near its group's average until more people rate it.
            </p>
            <Link to="/ph/methodology" className="link mt-2 inline-block text-sm font-semibold">
              How scores work
            </Link>
          </div>
          <div>
            <h2 className="font-bold">Real anonymity, honest limits</h2>
            <p className="mt-1 text-sm text-muted">
              Signing in only gives your device a private voting pass. Your ratings are sent separately, and nothing we store links them to you.
            </p>
            <Link to="/about" className="link mt-2 inline-block text-sm font-semibold">
              How anonymity works
            </Link>
          </div>
          <div>
            <h2 className="font-bold">Independent</h2>
            <p className="mt-1 text-sm text-muted">
              Not a government website. Agencies cannot pay for placement, edit scores or see who rated them. Ratings that fail our checks are not
              counted.
            </p>
            <Link to="/ph/transparency" className="link mt-2 inline-block text-sm font-semibold">
              Integrity report
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
