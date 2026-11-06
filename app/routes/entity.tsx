import { useState } from "react";
import { Link, redirect, data } from "react-router";
import type { Route } from "./+types/entity";
import { envFrom, requireCountry } from "../lib/route.server";
import { entityBySlug, nearbyEntities, parsePeriod } from "../lib/data.server";
import { pageMeta } from "../lib/meta";
import { ENTITY_TYPE_LABEL, entityPath, entityPathKind } from "../../shared/directory";
import { SCORING, countedRatings, formatScore } from "../../shared/scoring";
import { Histogram, ScaleBar, ScoreValue } from "../components/Score";
import { EntityCard } from "../components/EntityCard";
import { RatePanel } from "../components/RatePanel";
import { useConfig } from "../lib/config";
import { useWallet } from "../wallet/WalletContext";

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const country = await requireCountry(context, params.country);
  const env = envFrom(context);
  const url = new URL(request.url);
  const kind = url.pathname.split("/")[2] as "agency" | "office";
  const found = await entityBySlug(env.DIRECTORY, country.code, params.slug);
  if (!found) throw data("Listing not found", { status: 404 });
  if (found.kind === "redirect") throw redirect(entityPath(country.pathSegment, found.type, found.slug) + url.search, 301);
  const entity = found.entity;
  if (entityPathKind(entity.type) !== kind) throw redirect(entityPath(country.pathSegment, entity.type, entity.slug) + url.search, 301);
  const nearby = await nearbyEntities(env.DIRECTORY, entity, 5);
  return { country, entity, nearby, period: parsePeriod(url.searchParams.get("period")), origin: env.PUBLIC_ORIGIN };
}

export const meta: Route.MetaFunction = ({ loaderData: d }) => {
  if (!d) return [{ title: "Not found · GovZones" }];
  const e = d.entity;
  const s = e.scores["12m"];
  const score = s.displayable ? `Rated ${formatScore(s.mean)}/10 from ${s.count} rating${s.count === 1 ? "" : "s"}.` : "No ratings yet.";
  return pageMeta({
    title: `${e.name}${e.acronym ? ` (${e.acronym})` : ""} — ratings · GovZones Philippines`,
    description: `${ENTITY_TYPE_LABEL[e.type]} · ${e.place}. ${score} Anonymous 1–10 ratings on an independent site.`,
    origin: d.origin,
    path: entityPath(d.country.pathSegment, e.type, e.slug),
  });
};

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium" });

function ShareButton({ title, url }: { title: string; url: string }) {
  const [state, setState] = useState<"idle" | "copied">("idle");
  return (
    <button
      type="button"
      className="btn-secondary text-sm"
      onClick={async () => {
        if (navigator.share) {
          await navigator.share({ title, url }).catch(() => undefined);
          return;
        }
        await navigator.clipboard?.writeText(url);
        setState("copied");
        setTimeout(() => setState("idle"), 2000);
      }}
    >
      {state === "copied" ? "Link copied" : "Share"}
    </button>
  );
}

function CorrectionForm({ entityId }: { entityId: string }) {
  const config = useConfig();
  const { session } = useWallet();
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");
  if (!session?.signedIn) {
    return (
      <p className="text-sm text-muted">
        <Link className="link" to="/sign-in">
          Sign in
        </Link>{" "}
        to report incorrect details. Reports are reviewed by directory curators; they never affect ratings.
      </p>
    );
  }
  if (state === "sent") return <p className="notice-ok">Thank you. A curator will check your report against official sources.</p>;
  return (
    <form
      className="grid gap-2"
      onSubmit={async (ev) => {
        ev.preventDefault();
        const f = new FormData(ev.currentTarget);
        setState("sending");
        try {
          const { accountsCall } = await import("../wallet/clients");
          await accountsCall(config, `/api/v1/entities/${entityId}/corrections`, "POST", {
            field: f.get("field"),
            details: f.get("details"),
            sourceUrl: f.get("sourceUrl") || undefined,
          });
          setState("sent");
        } catch (e) {
          setMsg(e instanceof Error ? e.message : "Could not send.");
          setState("error");
        }
      }}
    >
      <label className="label" htmlFor="c-field">
        What is wrong?
      </label>
      <select id="c-field" name="field" className="field" required>
        <option value="name">Name</option>
        <option value="address">Address or location</option>
        <option value="website">Official website</option>
        <option value="parent">Parent agency</option>
        <option value="status">Closed, moved or renamed</option>
        <option value="duplicate">Duplicate listing</option>
        <option value="other">Other</option>
      </select>
      <label className="label" htmlFor="c-details">
        Details (no personal information, please)
      </label>
      <textarea id="c-details" name="details" className="field min-h-24" required maxLength={1000} />
      <label className="label" htmlFor="c-src">
        Official source link (optional)
      </label>
      <input id="c-src" name="sourceUrl" type="url" className="field" placeholder="https://" />
      {state === "error" && <p className="notice">{msg}</p>}
      <div>
        <button className="btn-secondary" disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : "Send report"}
        </button>
      </div>
    </form>
  );
}

export default function EntityPage({ loaderData }: Route.ComponentProps) {
  const { entity: e, nearby, period, country, origin } = loaderData;
  const score = e.scores[period];
  const kindLabel = e.type === "AGENCY" || e.type === "OTHER_PUBLIC_BODY" ? "agency" : e.type === "LGU" ? "local government" : "office";
  const path = entityPath(country.pathSegment, e.type, e.slug);
  const periodLabel = period === "12m" ? "last 12 months" : "all time";
  const placeCrumbs = e.breadcrumbs.filter((b) => b.type !== "BARANGAY");
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "GovernmentOrganization",
    name: e.name,
    ...(e.acronym ? { alternateName: e.acronym } : {}),
    ...(e.officialUrl ? { url: e.officialUrl } : {}),
    ...(e.address ? { address: e.address } : {}),
    ...(e.scores["12m"].displayable
      ? { aggregateRating: { "@type": "AggregateRating", ratingValue: formatScore(e.scores["12m"].mean), bestRating: 10, worstRating: 1, ratingCount: e.scores["12m"].count } }
      : {}),
  };

  return (
    <div className={`container-page py-6 ${e.ratable ? "pb-24 lg:pb-6" : ""}`}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <ol className="flex flex-wrap items-center gap-x-1.5">
          <li>
            <Link className="link-plain" to="/ph">
              Philippines
            </Link>
          </li>
          {e.parent && (
            <li>
              <span aria-hidden="true">›</span>{" "}
              <Link className="link-plain" to={entityPath("ph", e.parent.type, e.parent.slug)}>
                {e.parent.acronym ?? e.parent.name}
              </Link>
            </li>
          )}
          {placeCrumbs.map((b) => (
            <li key={b.id}>
              <span aria-hidden="true">›</span>{" "}
              <Link className="link-plain" to={`/ph/places/${b.id}`}>
                {b.name}
              </Link>
            </li>
          ))}
        </ol>
      </nav>

      <header className="mt-4">
        <p className="flex flex-wrap items-center gap-1.5">
          <span className="badge border-accent/30 bg-accent-soft text-accent-strong">{ENTITY_TYPE_LABEL[e.type]}</span>
          {e.verifiedAt ? (
            <span className="badge border-ok-line/50 bg-ok-bg text-ok-line">✓ Verified {fmtDate(e.verifiedAt)}</span>
          ) : (
            <span className="badge border-warn-line/50 bg-warn-bg text-gold">Not yet verified</span>
          )}
        </p>
        <h1 className="mt-2 text-2xl font-extrabold leading-tight tracking-tight sm:text-4xl">
          {e.name}
          {e.acronym && <span className="ml-2 text-lg font-semibold text-muted sm:text-2xl">({e.acronym})</span>}
        </h1>
        <p className="mt-1 text-muted">{e.place}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {e.ratable && (
            <a href="#rate" className="btn-primary lg:hidden">
              Rate this {kindLabel}
            </a>
          )}
          {e.officialUrl && (
            <a className="btn-secondary text-sm" href={e.officialUrl} rel="noopener noreferrer nofollow" target="_blank">
              Official website ↗
            </a>
          )}
          <ShareButton title={`${e.name} on GovZones`} url={`${origin}${path}`} />
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="score-h" className="card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="score-h" className="text-lg font-bold">
                Public score
              </h2>
              <nav aria-label="Period" className="segmented">
                <Link to="?period=12m" aria-current={period === "12m" ? "page" : undefined} preventScrollReset>
                  12 months
                </Link>
                <Link to="?period=all" aria-current={period === "all" ? "page" : undefined} preventScrollReset>
                  All time
                </Link>
              </nav>
            </div>
            {score.displayable ? (
              <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-3">
                <div>
                  <ScoreValue mean={score.mean} size="xl" />
                  <ScaleBar mean={score.mean} className="mt-2 !h-3 !max-w-[14rem]" />
                </div>
                <p className="text-sm">
                  <strong className="text-base">{score.count.toLocaleString("en")}</strong> rating{score.count === 1 ? "" : "s"} · {periodLabel}
                  <br />
                  <span className="text-muted">{score.qualifiesForRanking ? "Included in rankings" : `Ranked once it has ${countedRatings(SCORING.minRankingVotes)}`}</span>
                </p>
              </div>
            ) : (
              <div className="mt-4">
                <p className="text-2xl font-extrabold tracking-tight">{score.count === 0 ? "No ratings yet" : "Not enough ratings yet"}</p>
                <p className="mt-1 text-sm text-muted">
                  {score.count === 0 ? "No ratings counted yet" : `${score.count} rating${score.count === 1 ? "" : "s"}`} ({periodLabel}).{" "}
                  {SCORING.profileMinDisplay <= 1 ? "The score appears as soon as the first rating is counted" : `A score appears from ${SCORING.profileMinDisplay} ratings`}
                  {e.ratable ? (score.count === 0 ? "; yours could be the first." : "; yours could be one of them.") : "; this listing is not open for rating."}
                </p>
                {SCORING.profileMinDisplay > 1 && (
                  <div className="mt-3 flex gap-1" aria-hidden="true">
                    {Array.from({ length: SCORING.profileMinDisplay }, (_, i) => (
                      <span key={i} className={`h-2 w-8 rounded-full ${i < score.count ? "bg-accent" : "bg-sunken"}`} />
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="mt-5">
              <Histogram cells={score.histogram} total={score.count} />
            </div>
            <p className="mt-4 text-xs text-muted">
              Simple average of counted ratings (1 = very poor, 10 = excellent). Updated{" "}
              {score.computedAt ? new Date(score.computedAt).toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" }) : "not yet"} ·{" "}
              <Link to="/ph/methodology" className="link">
                how scores work
              </Link>
            </p>
          </section>

          {(e.description || e.address || e.aliases.length > 0 || e.parent) && (
            <section aria-labelledby="about-h" className="card">
              <h2 id="about-h" className="text-lg font-bold">
                About this listing
              </h2>
              {e.description && <p className="mt-2">{e.description}</p>}
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
                {e.address && (
                  <>
                    <dt className="font-semibold">Address</dt>
                    <dd>{e.address}</dd>
                  </>
                )}
                {e.aliases.length > 0 && (
                  <>
                    <dt className="font-semibold">Also known as</dt>
                    <dd>{e.aliases.join(" · ")}</dd>
                  </>
                )}
                {e.parent && (
                  <>
                    <dt className="font-semibold">Part of</dt>
                    <dd>
                      <Link className="link" to={entityPath("ph", e.parent.type, e.parent.slug)}>
                        {e.parent.name}
                      </Link>{" "}
                      <span className="text-muted">(rated separately)</span>
                    </dd>
                  </>
                )}
              </dl>
            </section>
          )}

          {e.childCount > 0 && (
            <section aria-labelledby="branches-h" className="card">
              <h2 id="branches-h" className="text-lg font-bold">
                Offices under this {kindLabel}
              </h2>
              <p className="mt-1 text-sm text-muted">
                Each office has its own rating. Rating this {kindLabel} does not rate its offices, and the other way round.
              </p>
              {e.branchSummary && e.branchSummary.ratings > 0 && (
                <div className="mt-3 rounded-xl bg-sunken p-3 text-sm">
                  <p className="font-semibold">Branch network summary</p>
                  <p>
                    {e.branchSummary.mean !== null ? `${formatScore(e.branchSummary.mean)} / 10` : "–"} average across{" "}
                    {e.branchSummary.ratings.toLocaleString("en")} ratings of {e.branchSummary.entities} listed offices (last 12 months). This pools the
                    offices' own ratings; it is <strong>not</strong> a rating of the {kindLabel} itself.
                  </p>
                </div>
              )}
              <ul className="mt-3 space-y-2">
                {e.children.map((c) => (
                  <EntityCard key={c.id} entity={c} />
                ))}
              </ul>
              {e.childCount > e.children.length && (
                <Link to={`/ph/search?q=${encodeURIComponent(e.acronym ?? e.name)}`} className="link mt-3 inline-block text-sm font-semibold">
                  See all {e.childCount} offices →
                </Link>
              )}
            </section>
          )}

          {nearby.length > 0 && (
            <section aria-labelledby="nearby-h" className="card">
              <h2 id="nearby-h" className="text-lg font-bold">
                Other offices in {placeCrumbs.at(-1)?.name ?? "this area"}
              </h2>
              <ul className="mt-3 space-y-2">
                {nearby.map((c) => (
                  <EntityCard key={c.id} entity={c} />
                ))}
              </ul>
              {placeCrumbs.at(-1) && (
                <Link to={`/ph/places/${placeCrumbs.at(-1)!.id}`} className="link mt-3 inline-block text-sm font-semibold">
                  Everything in {placeCrumbs.at(-1)!.name} →
                </Link>
              )}
            </section>
          )}

          <section aria-labelledby="sources-h" className="card-flat text-sm">
            <h2 id="sources-h" className="text-lg font-bold">
              Sources &amp; corrections
            </h2>
            {e.sources.length ? (
              <ul className="mt-2 list-disc pl-5">
                {e.sources.map((s) => (
                  <li key={s.url}>
                    <a className="link" href={s.url} rel="noopener noreferrer nofollow" target="_blank">
                      {s.publisher}
                    </a>{" "}
                    <span className="text-muted">— {s.checkedAt ? `checked ${fmtDate(s.checkedAt)}` : "not yet checked"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-muted">No source has been attached yet.</p>
            )}
            <p className="mt-2 text-muted">
              Listing last updated {fmtDate(e.updatedAt)}. GovZones links to official sites for reference only and uses no government insignia.
            </p>
            <details className="mt-3">
              <summary className="link cursor-pointer py-2 font-semibold">Report incorrect details</summary>
              <div className="mt-2">
                <CorrectionForm entityId={e.id} />
              </div>
            </details>
          </section>
        </div>

        <div id="rate" className="min-w-0 scroll-mt-20 lg:sticky lg:top-20 lg:self-start">
          <RatePanel entity={{ id: e.id, name: e.name, path, ratable: e.ratable }} country={e.countryCode} kindLabel={kindLabel} />
        </div>
      </div>

      {e.ratable && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper/95 p-3 backdrop-blur lg:hidden" aria-hidden="true">
          <div className="container-page flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-semibold">{e.acronym ?? e.name}</span>
            <a href="#rate" className="btn-primary shrink-0" tabIndex={-1}>
              Rate this {kindLabel}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
