import { Form, Link } from "react-router";
import type { Route } from "./+types/search";
import { envFrom, requireCountry } from "../lib/route.server";
import { decodeCursor, geoChildren, searchEntities, typesForScope } from "../lib/data.server";
import { pageMeta } from "../lib/meta";
import { ENTITY_TYPES, ENTITY_TYPE_LABEL, QUICK_FILTERS } from "../../shared/directory";
import { SearchBox } from "../components/SearchBox";
import { EntityCard } from "../components/EntityCard";

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const country = await requireCountry(context, params.country);
  const env = envFrom(context);
  const url = new URL(request.url);
  const sp = url.searchParams;
  const q = (sp.get("q") ?? "").slice(0, 120);
  const scope = sp.get("scope");
  const type = sp.get("type");
  const region = sp.get("region") || null;
  const province = sp.get("province") || null;
  const city = sp.get("city") || null;
  const min = Math.max(0, Number(sp.get("min") ?? 0) || 0);
  const offset = decodeCursor(sp.get("cursor"));
  const [results, regions, provinces, cities] = await Promise.all([
    searchEntities(env.DIRECTORY, {
      country: country.code,
      q,
      types: typesForScope(scope, type),
      regionId: region,
      provinceId: province,
      cityId: city,
      minVotes: min,
      offset,
      limit: 20,
    }),
    geoChildren(env.DIRECTORY, country.code, null, "REGION"),
    region ? geoChildren(env.DIRECTORY, country.code, region, "PROVINCE") : Promise.resolve([]),
    province ? geoChildren(env.DIRECTORY, country.code, province) : region ? geoChildren(env.DIRECTORY, country.code, region, "CITY") : Promise.resolve([]),
  ]);
  return { q, scope, type, region, province, city, min, offset, results, regions, provinces, cities };
}

export const meta: Route.MetaFunction = ({ loaderData: data }) =>
  pageMeta({
    title: data?.q ? `“${data.q}” — Search · GovZones Philippines` : "Search agencies and offices · GovZones Philippines",
    description: "Search Philippine government agencies, local governments and service offices by name, abbreviation or place.",
    noindex: true,
  });

export default function Search({ loaderData }: Route.ComponentProps) {
  const { q, scope, type, region, province, city, min, offset, results, regions, provinces, cities } = loaderData;
  const nextParams = new URLSearchParams();
  for (const [k, v] of Object.entries({ q, scope, type, region, province, city, min: min ? String(min) : "" })) if (v) nextParams.set(k, String(v));
  const active: string[] = [];
  if (type) active.push(ENTITY_TYPE_LABEL[type as keyof typeof ENTITY_TYPE_LABEL] ?? type);
  else if (scope && scope in QUICK_FILTERS) active.push(QUICK_FILTERS[scope as keyof typeof QUICK_FILTERS].label);
  if (region) active.push(regions.find((r) => r.id === region)?.shortName ?? "Region");
  if (province) active.push(provinces.find((p) => p.id === province)?.name ?? "Province");
  if (city) active.push(cities.find((c) => c.id === city)?.name ?? "City");
  if (min) active.push(`${min}+ ratings`);
  const moreOpen = Boolean(type || region || province || city || min);

  return (
    <div className="container-page py-6">
      <p className="eyebrow">Directory</p>
      <h1 className="section-title mb-4 text-2xl sm:text-3xl">Search agencies and offices</h1>
      <SearchBox defaultValue={q} label="Search by name, abbreviation or place" />

      <Form method="get" className="card mt-4" aria-label="Filters">
        <input type="hidden" name="q" value={q} />
        <fieldset>
          <legend className="label">Kind of listing</legend>
          <div className="flex flex-wrap gap-2">
            {[["", "All"], ...Object.entries(QUICK_FILTERS).map(([k, v]) => [k, v.label])].map(([value, label]) => (
              <label key={value} className="chip cursor-pointer has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-accent-ink">
                <input type="radio" name="scope" value={value} defaultChecked={(scope ?? "") === value && !type} className="sr-only" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <details className="mt-3" open={moreOpen}>
          <summary className="link cursor-pointer py-1 text-sm font-semibold">More filters (place, exact type, minimum ratings)</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="min-w-0">
              <label className="label" htmlFor="f-type">
                Exact type
              </label>
              <select id="f-type" name="type" className="field" defaultValue={type ?? ""}>
                <option value="">Any type</option>
                {ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ENTITY_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <label className="label" htmlFor="f-region">
                Region
              </label>
              <select id="f-region" name="region" className="field" defaultValue={region ?? ""}>
                <option value="">All regions</option>
                {regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.shortName ?? r.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <label className="label" htmlFor="f-province">
                Province
              </label>
              <select id="f-province" name="province" className="field" defaultValue={province ?? ""} disabled={!region || provinces.length === 0}>
                <option value="">{region ? "All provinces" : "Choose a region first"}</option>
                {provinces.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <label className="label" htmlFor="f-city">
                City / municipality
              </label>
              <select id="f-city" name="city" className="field" defaultValue={city ?? ""} disabled={cities.length === 0}>
                <option value="">{cities.length ? "All" : "Choose a province or region"}</option>
                {cities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <label className="label" htmlFor="f-min">
                Minimum ratings
              </label>
              <select id="f-min" name="min" className="field" defaultValue={String(min)}>
                <option value="0">Any</option>
                <option value="1">1+ (rated)</option>
                <option value="5">5+</option>
                <option value="30">30+</option>
                <option value="100">100+</option>
              </select>
            </div>
          </div>
        </details>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary" type="submit">
            Apply filters
          </button>
          {(active.length > 0 || scope) && (
            <Link className="btn-secondary" to={q ? `?q=${encodeURIComponent(q)}` : "?"}>
              Clear filters
            </Link>
          )}
        </div>
      </Form>

      <section aria-labelledby="results-h" className="mt-6">
        <h2 id="results-h" className="sr-only">
          Results
        </h2>
        {results.items.length === 0 ? (
          <div className="card-flat">
            <p className="font-semibold">No matching listings{q ? ` for “${q}”` : ""}.</p>
            <p className="mt-1 text-sm text-muted">
              Try an abbreviation (e.g. “BIR”), a city name, or fewer words. If the office truly is missing, you can suggest it. Suggestions are checked
              against official sources before they are published.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link to="/ph/suggest" className="btn-secondary">
                Suggest a missing office
              </Link>
              <Link to="/ph/places" className="btn-ghost">
                Browse by place
              </Link>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted" aria-live="polite">
              <span>
                Showing {offset + 1}–{offset + results.items.length}
                {q ? ` for “${q}”` : ""}
              </span>
              {active.map((a) => (
                <span key={a} className="badge border-line bg-paper text-muted">
                  {a}
                </span>
              ))}
              <span className="text-faint">· scores use ratings from the last 12 months</span>
            </p>
            <ul className="space-y-2">
              {results.items.map((e) => (
                <EntityCard key={e.id} entity={e} />
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              {offset > 0 && (
                <Link className="btn-secondary" to={`?${nextParams.toString()}`}>
                  First page
                </Link>
              )}
              {results.nextCursor && (
                <Link className="btn-secondary" to={`?${nextParams.toString()}&cursor=${results.nextCursor}`}>
                  More results
                </Link>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
