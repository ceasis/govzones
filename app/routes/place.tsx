import { Link, data } from "react-router";
import type { Route } from "./+types/place";
import { envFrom, requireCountry } from "../lib/route.server";
import { rankings, searchEntities } from "../lib/data.server";
import { geoFilterFor, placeAncestors, placeById, placeChildren, searchParamFor } from "../lib/places.server";
import { GEO_TYPE_LABEL } from "../../shared/directory";
import { SCORING, countedRatings } from "../../shared/scoring";
import { RankingList } from "../components/RankingList";
import { EntityCard } from "../components/EntityCard";

export async function loader({ context, params }: Route.LoaderArgs) {
  const country = await requireCountry(context, params.country);
  const env = envFrom(context);
  const unit = await placeById(env.DIRECTORY, country.code, params.id);
  if (!unit) throw data("Place not found", { status: 404 });
  const filter = geoFilterFor(unit);
  const [ancestors, children, best, listings] = await Promise.all([
    placeAncestors(env.DIRECTORY, unit),
    placeChildren(env.DIRECTORY, country.code, unit.id),
    rankings(env.PUBLIC_CACHE, country.code, { cohort: "mixed", period: "12m", kind: "best", ...filter, limit: 5 }),
    searchEntities(env.DIRECTORY, { country: country.code, ...filter, limit: 50 }),
  ]);
  return { country, unit, ancestors, children, best, listings, searchParam: searchParamFor(unit) };
}

export const meta: Route.MetaFunction = ({ loaderData: d }) => {
  if (!d) return [{ title: "Place not found · GovZones" }];
  const label = GEO_TYPE_LABEL[d.unit.type] ?? d.unit.type;
  return [
    { title: `${d.unit.name} — government offices and ratings · GovZones Philippines` },
    {
      name: "description",
      content: `${label} in the Philippines: ${d.unit.listings} listed government agencies and offices in ${d.unit.name}, with anonymous 1–10 ratings. Independent; not a government site.`,
    },
  ];
};

export default function Place({ loaderData }: Route.ComponentProps) {
  const { country, unit, ancestors, children, best, listings, searchParam } = loaderData;
  const seg = country.pathSegment;
  const label = GEO_TYPE_LABEL[unit.type] ?? unit.type;
  const childLabel = unit.type === "REGION" ? "Provinces and cities" : unit.type === "PROVINCE" ? "Cities and municipalities" : "Districts";
  const periodLabel = "Last 12 months";
  const searchHref = `/${seg}/search?${searchParam}=${encodeURIComponent(unit.id)}`;

  return (
    <div className="container-page py-6 sm:py-8">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <ol className="flex flex-wrap items-center gap-x-1">
          <li>
            <Link className="link" to={`/${seg}`}>
              {country.name}
            </Link>
          </li>
          <li>
            <span aria-hidden="true">›</span>{" "}
            <Link className="link" to={`/${seg}/places`}>
              Browse by place
            </Link>
          </li>
          {ancestors.map((a) => (
            <li key={a.id}>
              <span aria-hidden="true">›</span>{" "}
              <Link className="link" to={`/${seg}/places/${encodeURIComponent(a.id)}`}>
                {a.shortName ?? a.name}
              </Link>
            </li>
          ))}
          <li aria-current="page">
            <span aria-hidden="true">›</span> {unit.name}
          </li>
        </ol>
      </nav>

      <header className="mt-3">
        <p className="eyebrow">{label}</p>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight sm:text-3xl">
          {unit.name}
          {unit.shortName && unit.shortName !== unit.name && <span className="ml-2 text-xl font-semibold text-muted">({unit.shortName})</span>}
        </h1>
        <p className="mt-2 text-muted">
          {unit.listings.toLocaleString("en")} listed government agenc{unit.listings === 1 ? "y or office" : "ies and offices"}
          {ancestors.length ? ` · ${ancestors.map((a) => a.shortName ?? a.name).join(", ")}` : ""}
        </p>
      </header>

      {children.length > 0 && (
        <section className="mt-6" aria-labelledby="children-h">
          <h2 id="children-h" className="section-title">
            {childLabel}
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {children.map((c) => (
              <li key={c.id} className="min-w-0 max-w-full">
                <Link className="chip max-w-full" to={`/${seg}/places/${encodeURIComponent(c.id)}`}>
                  <span className="truncate">{c.name}</span>
                  <span className="shrink-0 text-xs font-normal text-muted">{c.listings}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8" aria-labelledby="best-h">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="best-h" className="section-title">
            Best rated in {unit.shortName ?? unit.name}
          </h2>
          <Link className="link text-sm" to={`/${seg}/rankings?type=mixed${searchParam === "region" ? `&region=${encodeURIComponent(unit.id)}` : ""}`}>
            Full ranking
          </Link>
        </div>
        <p className="mb-3 mt-1 text-sm text-muted">
          All listing types · {periodLabel} · every listing with at least {countedRatings(SCORING.minRankingVotes)}. Each one is compared with others of
          its own kind.
        </p>
        {best.rows.length ? (
          <RankingList rows={best.rows} periodLabel={periodLabel} country={seg} />
        ) : (
          <div className="card text-sm">
            <p className="font-semibold">Nothing in {unit.name} has been rated yet.</p>
            <p className="mt-1 text-muted">
              A listing appears here as soon as it has {countedRatings(SCORING.minRankingVotes)} in the last 12 months. We never fill this list with made-up
              results. Rate an office you have used to put it on the board.
            </p>
          </div>
        )}
      </section>

      <section className="mt-8" aria-labelledby="all-h">
        <h2 id="all-h" className="section-title">
          All listings in {unit.shortName ?? unit.name}
        </h2>
        {listings.items.length === 0 ? (
          <div className="card mt-3 text-sm">
            <p className="font-semibold">No office is listed here yet.</p>
            <p className="mt-1 text-muted">The directory is still growing. If you know a government office in {unit.name}, you can suggest it.</p>
            <Link to={`/${seg}/suggest`} className="btn-secondary mt-3">
              Suggest a missing office
            </Link>
          </div>
        ) : (
          <>
            <p className="mb-2 mt-1 text-sm text-muted">
              Showing {listings.items.length} of {unit.listings.toLocaleString("en")}. Scores use ratings from the last 12 months.
            </p>
            <ul className="space-y-2">
              {listings.items.map((e) => (
                <EntityCard key={e.id} entity={e} country={seg} />
              ))}
            </ul>
            {listings.nextCursor && (
              <Link className="btn-secondary mt-4" to={searchHref}>
                More listings in {unit.shortName ?? unit.name}
              </Link>
            )}
          </>
        )}
      </section>
    </div>
  );
}
