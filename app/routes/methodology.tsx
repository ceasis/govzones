import { Link } from "react-router";
import type { Route } from "./+types/methodology";
import { METHODOLOGY_CHANGED_ON, SCORING, countedRatings } from "../../shared/scoring";

export const meta: Route.MetaFunction = () => [
  { title: "How scores and rankings work · GovZones Philippines" },
  { name: "description", content: "How GovZones turns anonymous 1–10 ratings into scores and rankings, explained in plain language." },
];

export default function Methodology() {
  const floor = countedRatings(SCORING.minRankingVotes);
  return (
    <article className="container-page prose-civic max-w-3xl py-8">
      <h1 className="text-2xl font-bold">How scores and rankings work</h1>
      <p className="text-sm text-muted">These rules were last changed on {METHODOLOGY_CHANGED_ON}. Any change is announced on this page.</p>

      <h2>What a rating is</h2>
      <ul>
        <li>One whole number from 1 (very poor) to 10 (excellent). No half points, stars, written reviews, photos or comments.</li>
        <li>Each person has one rating per agency or office. Changing it replaces the old one; it never adds a second vote.</li>
        <li>You can change a rating once every {SCORING.cooldownDays} days and delete it at any time.</li>
        <li>
          National agencies, local governments and individual offices are rated separately. Rating an agency does not rate its branches, and rating a
          branch does not rate its parent.
        </li>
        <li>Only government organisations and service offices can be rated, never politicians, individual employees or private citizens.</li>
      </ul>

      <h2>Ratings are checked before they count</h2>
      <p>
        Every rating we receive is kept, but only ratings that pass our checks are <strong>counted</strong>. Ratings that are new, under review or
        rejected count for nothing anywhere: not in averages, counts, breakdowns, rankings or downloads.
      </p>
      <ol>
        <li>The rating must come from an account that has passed our sign-up checks.</li>
        <li>It is held for {SCORING.maturationHours} hours first, so that unusual activity can be looked at before it counts.</li>
        <li>
          Our checks against fake or coordinated ratings can hold a rating back for review. A low score or criticism of an agency is never, by itself, a
          reason to hold a rating back.
        </li>
      </ol>
      <p>
        We do not publish the exact rules of these checks, because that would help people get around them. We do publish the totals in the{" "}
        <Link to="/ph/transparency">integrity report</Link>. No check can catch every abuse, and we never claim that every rating we receive is counted.
      </p>

      <h2>The score you see</h2>
      <p>
        The score is the simple average of all counted ratings: add them up and divide by how many there are. It is shown to one decimal place (for
        example 7.8 out of 10), always next to the number of ratings.{" "}
        {SCORING.profileMinDisplay <= 1
          ? "A score appears from the first counted rating, and so does the breakdown of how many people gave each number from 1 to 10."
          : `A score appears once a listing has ${countedRatings(SCORING.profileMinDisplay)}, and the breakdown of 1–10 ratings from ${countedRatings(SCORING.histogramMinTotal)}.`}
        {SCORING.histogramMinBucket > 1 ? ` Very small groups are shown as “fewer than ${SCORING.histogramMinBucket}”.` : ""} One rating can only reflect
        one visit, so always read a score together with its number of ratings.
      </p>
      <ul>
        <li>
          <strong>Last 12 months</strong> (the default) uses counted ratings given or last changed within the last 365 days.
        </li>
        <li>
          <strong>All time</strong> uses every counted rating.
        </li>
      </ul>

      <h2>How rankings are ordered</h2>
      <ul>
        <li>
          Rankings compare like with like: national agencies with national agencies, local governments with local governments, offices with offices. A
          mixed list is shown only when you choose it.
        </li>
        <li>A listing appears in Best Rated and Lowest Rated as soon as it has {floor} in the chosen period.</li>
        <li>
          To stop one or two ratings from deciding the top and bottom of a list, a listing with only a few ratings is kept close to the average of its
          group until more people rate it. The more ratings it has, the more its own average decides its place. At around {SCORING.priorStrength}{" "}
          ratings, a listing's own average and its group's average carry equal weight; beyond that, its own average takes over. The score shown is
          always the listing's own average.
        </li>
        <li>If few listings have been rated, we show a short or empty list rather than filling it with made-up results.</li>
        <li>When two listings are level, the one with more ratings comes first, then they are ordered by name. There is no paid placement of any kind.</li>
        <li>“Lowest rated” means lowest rated by users among rated listings. It is not an official finding.</li>
      </ul>
      <p>
        Scores refresh within about a minute of a rating being counted, and rankings within about five minutes. Each page shows when it was last
        updated.
      </p>

      <h2>Branch network summaries</h2>
      <p>
        An agency page may show a “branch network summary”. It pools the separate ratings of the agency's listed offices into one average, and is
        clearly labelled as not being a rating of the agency itself.
      </p>

      <h2>Your ratings are anonymous</h2>
      <p>
        Ratings go to a separate service that accepts no cookies or logins. It can check that a rating comes from a real registered voting pass without
        learning whose it is. Your ratings of different offices cannot be matched to each other, and nothing we store links a rating to an account.
        There are limits to this, explained plainly on <Link to="/about">how anonymity works</Link>.
      </p>

      <h2>What these numbers are not</h2>
      <p>
        GovZones scores are people's own opinions. They are not official performance audits, surveys or government data, and they are not endorsed by
        any agency.
      </p>
    </article>
  );
}
