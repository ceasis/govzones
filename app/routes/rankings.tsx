import { Form, Link } from "react-router";
import type { Route } from "./+types/rankings";
import { envFrom, requireCountry } from "../lib/route.server";
import { decodeCursor, geoChildren, parseCohort, parsePeriod, rankings, type RankingKind } from "../lib/data.server";
import { pageMeta } from "../lib/meta";
import { COHORT_LABEL, RANKING_COHORTS } from "../../shared/directory";
import { countedRatings, formatScore } from "../../shared/scoring";
import { RankingList } from "../components/RankingList";

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const country = await requireCountry(context, params.country);
  const env = envFrom(context);
  const sp = new URL(request.url).searchParams;
  const kindParam = sp.get("kind");
  const kind: RankingKind = kindParam === "lowest" ? "lowest" : kindParam === "most" ? "most" : "best";
  const cohort = parseCohort(sp.get("type"));
  const period = parsePeriod(sp.get("period"));
  const region = sp.get("region") || null;
  const offset = decodeCursor(sp.get("cursor"));
  const [view, regions] = await Promise.all([
    rankings(env.PUBLIC_CACHE, country.code, { cohort, period, kind, regionId: region, offset, limit: 25 }),
    geoChildren(env.DIRECTORY, country.code, null, "REGION"),
  ]);
  return { view, regions, kind, cohort, period, region, offset, origin: env.PUBLIC_ORIGIN };
}

const KIND_LABEL: Record<RankingKind, string> = { best: "Best Rated", lowest: "Lowest Rated", most: "Most Rated" };

export const meta: Route.MetaFunction = ({ loaderData: d }) =>
  pageMeta({
    title: `${d ? KIND_LABEL[d.kind] : "Rankings"} ${d ? COHORT_LABEL[d.cohort].toLowerCase() : ""} · GovZones Philippines`,
    description: "Best Rated, Lowest Rated and Most Rated Philippine government agencies and offices, from anonymous 1–10 ratings. Independent and transparent.",
    origin: d?.origin,
    path: "/ph/rankings",
  });

export default function Rankings({ loaderData }: Route.ComponentProps) {
  const { view, regions, kind, cohort, period, region, offset } = loaderData;
  const periodLabel = period === "12m" ? "Last 12 months" : "All time";
  const regionName = region ? regions.find((r) => r.id === region)?.name : null;
  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const merged = { kind, type: cohort, period, region, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `?${p.toString()}`;
  };
  return (
    <div className="container-page py-6">
      <p className="eyebrow">Rankings</p>
      <h1 className="section-title text-2xl sm:text-3xl">{KIND_LABEL[kind]}</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        These are people's own ratings, not official audits. “Lowest rated” means lowest rated by users, never an official finding.
      </p>

      <nav aria-label="Ranking type" className="segmented mt-4">
        {(["best", "lowest", "most"] as RankingKind[]).map((k) => (
          <Link key={k} to={qs({ kind: k, cursor: null })} aria-current={k === kind ? "page" : undefined}>
            {KIND_LABEL[k]}
          </Link>
        ))}
      </nav>

      <Form method="get" className="card mt-4" aria-label="Ranking filters">
        <input type="hidden" name="kind" value={kind} />
        <fieldset>
          <legend className="label">Compare</legend>
          <div className="flex flex-wrap gap-2">
            {RANKING_COHORTS.map((c) => (
              <label key={c} className="chip cursor-pointer has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-accent-ink">
                <input type="radio" name="type" value={c} defaultChecked={cohort === c} className="sr-only" />
                {COHORT_LABEL[c]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="min-w-0">
            <label className="label" htmlFor="r-period">
              Period
            </label>
            <select id="r-period" name="period" className="field" defaultValue={period}>
              <option value="12m">Last 12 months</option>
              <option value="all">All time</option>
            </select>
          </div>
          <div className="min-w-0">
            <label className="label" htmlFor="r-region">
              Region
            </label>
            <select id="r-region" name="region" className="field" defaultValue={region ?? ""}>
              <option value="">Philippines (all)</option>
              {regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.shortName ?? r.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn-primary" type="submit">
            Show ranking
          </button>
        </div>
      </Form>

      <section aria-labelledby="rank-h" className="mt-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="eyebrow">
              {periodLabel} · {regionName ?? "Philippines"}
            </p>
            <h2 id="rank-h" className="section-title">
              {COHORT_LABEL[cohort]}
            </h2>
          </div>
          <p className="text-sm text-muted">
            {kind === "most"
              ? "Sorted by number of ratings"
              : `${view.totalQualified} ranked listing${view.totalQualified === 1 ? "" : "s"}${view.minVotes > 1 ? ` (${view.minVotes} or more ratings)` : ""}`}
          </p>
        </div>
        {cohort === "mixed" && (
          <p className="notice mb-3">
            Mixed view: national agencies, local governments and offices listed together. Each one is still judged against others of its own kind.
          </p>
        )}
        {view.rows.length ? (
          <RankingList rows={view.rows} periodLabel={periodLabel} showQualification={kind === "most"} startRank={offset + 1} />
        ) : (
          <div className="card-flat text-sm">
            <p className="font-semibold">{kind === "most" ? "No ratings counted yet for this selection." : "Nothing in this selection has been rated yet."}</p>
            <p className="mt-1 text-muted">
              A listing is ranked as soon as it has {countedRatings(view.minVotes)} in the selected period. We show an empty list rather than a made-up one.
            </p>
            <Link to="/ph/search" className="btn-secondary mt-3">
              Find an office to rate
            </Link>
          </div>
        )}
        {view.nextCursor && (
          <Link className="btn-secondary mt-4" to={`${qs({})}&cursor=${view.nextCursor}`}>
            Next 25
          </Link>
        )}
      </section>

      <aside className="card-flat mt-8 text-sm text-muted" aria-label="How this ranking is ordered">
        <p>
          Listings with only a few ratings are kept close to their group's average{view.cohortMean !== null ? ` (currently ${formatScore(view.cohortMean)} out of 10)` : ""}{" "}
          until more people rate them, so one or two ratings cannot decide the top or bottom of the list. The score shown is each listing's own average.
          When two are level, the one with more ratings comes first. No paid placement.
        </p>
        <p className="mt-1">
          {view.cohortRatings.toLocaleString("en")} ratings counted in this group · updated{" "}
          {view.generatedAt ? new Date(view.generatedAt).toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" }) : "not yet"} ·{" "}
          <Link to="/ph/methodology" className="link">
            how rankings work
          </Link>
        </p>
      </aside>
    </div>
  );
}
