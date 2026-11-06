import { Link } from "react-router";
import type { Route } from "./+types/transparency";
import { envFrom, requireCountry } from "../lib/route.server";
import { directoryCounts, transparencyReport } from "../lib/data.server";

export async function loader({ context, params }: Route.LoaderArgs) {
  const country = await requireCountry(context, params.country);
  const env = envFrom(context);
  const [report, counts] = await Promise.all([transparencyReport(env.PUBLIC_CACHE, country.code), directoryCounts(env.DIRECTORY, country.code)]);
  return { report, counts };
}

export const meta: Route.MetaFunction = () => [{ title: "Integrity & transparency report · GovZones Philippines" }];

export default function Transparency({ loaderData }: Route.ComponentProps) {
  const { report, counts } = loaderData;
  const n = (k: string) => Number(report?.[k] ?? 0).toLocaleString("en");
  const rows: Array<[string, string, string]> = report
    ? [
        ["Ratings received", n("activeSubmissions"), "All current ratings we have received, counted or not."],
        ["Counted in public scores", n("counted"), "Ratings that passed our checks and count towards averages and rankings."],
        ["Not (yet) counted", n("pendingOrNotCounted"), "In the 24-hour hold, or from accounts that have not yet passed our sign-up checks."],
        ["Held back for review", n("withheldForReview"), "Flagged by our checks and waiting for a person to review them."],
        ["Excluded", n("excluded"), "Confirmed as fake or coordinated; can be appealed anonymously."],
        ["Anonymous appeals received", n("appealsReceived"), ""],
        ["Exclusions confirmed by staff", n("exclusionsConfirmed"), ""],
        ["Decisions reversed", n("reversals"), "Ratings restored after review or appeal."],
      ]
    : [];
  return (
    <div className="container-page max-w-3xl py-8">
      <h1 className="text-2xl font-bold">Integrity &amp; transparency report</h1>
      <p className="mt-2 text-muted">
        Totals only. We never publish individual ratings, account details or the exact rules of our checks.
      </p>
      {report ? (
        <>
          <dl className="mt-6 space-y-2">
            {rows.map(([label, value, help]) => (
              <div key={label} className="card flex flex-wrap items-baseline justify-between gap-2">
                <dt className="min-w-0 flex-1 basis-60">
                  <span className="font-semibold">{label}</span>
                  {help && <span className="block text-sm text-muted">{help}</span>}
                </dt>
                <dd className="text-xl font-bold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-sm text-muted">
            Updated {new Date(String(report.generatedAt)).toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" })}
          </p>
        </>
      ) : (
        <p className="card mt-6 text-sm">No report has been generated yet.</p>
      )}
      <section className="card mt-6 text-sm">
        <h2 className="font-bold">Directory coverage</h2>
        <p className="mt-1">
          {counts.total.toLocaleString("en")} active listings: {counts.national} national bodies, {counts.lgus} local governments and {counts.offices} service
          offices. {counts.verified} have been checked against official sources so far; the rest have not been checked yet. We do not claim to list every
          government service counter in the Philippines.
        </p>
      </section>
      <p className="mt-6 text-sm">
        See also: <Link className="link" to="/ph/methodology">how scores work</Link> · <Link className="link" to="/policies/appeals">fraud &amp; appeals policy</Link>
      </p>
    </div>
  );
}
