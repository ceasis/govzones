import { useId, useMemo, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/places";
import { envFrom, requireCountry } from "../lib/route.server";
import { placeIndex, regionsWithCounts } from "../lib/places.server";
import { GEO_TYPE_LABEL, normalizeText } from "../../shared/directory";

export async function loader({ context, params }: Route.LoaderArgs) {
  const country = await requireCountry(context, params.country);
  const env = envFrom(context);
  const [regions, places] = await Promise.all([regionsWithCounts(env.DIRECTORY, country.code), placeIndex(env.DIRECTORY, country.code)]);
  return { country, regions, places };
}

export const meta: Route.MetaFunction = () => [
  { title: "Browse by place — regions, provinces and cities · GovZones Philippines" },
  { name: "description", content: "Find government agencies and service offices by region, province, city or municipality in the Philippines." },
];

export default function Places({ loaderData }: Route.ComponentProps) {
  const { country, regions, places } = loaderData;
  const id = useId();
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const term = normalizeText(q);
    if (term.length < 2) return [];
    return places.filter((p) => normalizeText(`${p.name} ${p.shortName ?? ""} ${p.parentName ?? ""}`).includes(term)).slice(0, 30);
  }, [q, places]);
  const total = regions.reduce((n, r) => n + r.listings, 0);
  const seg = country.pathSegment;

  return (
    <div className="container-page py-6 sm:py-8">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link className="link" to={`/${seg}`}>
          {country.name}
        </Link>{" "}
        <span aria-hidden="true">›</span> Browse by place
      </nav>
      <header className="mt-3">
        <p className="eyebrow">Directory</p>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight sm:text-3xl">Browse by place</h1>
        <p className="mt-2 max-w-2xl text-muted">
          {regions.length} regions, {places.length.toLocaleString("en")} provinces, cities and municipalities, and {total.toLocaleString("en")} listed offices
          with a known location. National agencies without a single location are under{" "}
          <Link className="link" to={`/${seg}/search?scope=national`}>
            national agencies
          </Link>
          .
        </p>
      </header>

      <section className="card mt-6" aria-labelledby={`${id}-find`}>
        <label className="label" htmlFor={`${id}-input`} id={`${id}-find`}>
          Find a province or city
        </label>
        <input
          id={`${id}-input`}
          type="search"
          inputMode="search"
          autoComplete="off"
          className="field"
          placeholder="e.g. Cebu, Davao, Pasig"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-describedby={`${id}-hint`}
        />
        <p id={`${id}-hint`} className="mt-2 text-xs text-muted">
          Type at least two letters. Matches provinces, cities and municipalities by name.
        </p>
        {q.trim().length >= 2 && (
          <ul className="mt-3 flex flex-wrap gap-2" aria-live="polite" aria-label="Matching places">
            {matches.length === 0 && <li className="text-sm text-muted">No place matches “{q.trim()}”.</li>}
            {matches.map((p) => (
              <li key={p.id} className="min-w-0 max-w-full">
                <Link className="chip max-w-full" to={`/${seg}/places/${encodeURIComponent(p.id)}`}>
                  <span className="truncate">{p.name}</span>
                  <span className="shrink-0 text-xs font-normal text-muted">
                    {GEO_TYPE_LABEL[p.type] ?? p.type}
                    {p.regionShort ? ` · ${p.regionShort}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-labelledby={`${id}-regions`}>
        <h2 id={`${id}-regions`} className="section-title">
          Regions
        </h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {regions.map((r) => (
            <li key={r.id} className="min-w-0">
              <Link to={`/${seg}/places/${encodeURIComponent(r.id)}`} className="card card-hover flex min-w-0 items-start gap-3 no-underline">
                <span className="badge shrink-0 border-accent/30 bg-accent-soft text-accent-strong" aria-hidden="true">
                  {r.shortName ?? "—"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold leading-snug text-ink">{r.name}</span>
                  <span className="mt-0.5 block text-sm text-muted">
                    {r.listings.toLocaleString("en")} listing{r.listings === 1 ? "" : "s"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
