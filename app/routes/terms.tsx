import type { Route } from "./+types/terms";

export const meta: Route.MetaFunction = () => [{ title: "Terms of use · GovZones" }];

export default function Terms() {
  return (
    <article className="container-page prose-civic max-w-3xl py-8">
      <h1 className="text-2xl font-bold">Terms of use</h1>
      <p className="notice">Draft for legal review before public launch.</p>
      <h2>The service</h2>
      <p>
        GovZones is an independent public feedback website. It is not a government service, an official statistic or an endorsement. Ratings are people's
        own opinions, not official audits.
      </p>
      <h2>Fair use</h2>
      <ul>
        <li>Rate only government organisations or offices you have actually used. One honest rating per office.</li>
        <li>Do not create multiple accounts, buy or sell accounts, automate ratings, or coordinate campaigns to manipulate scores.</li>
        <li>Do not submit personal information about others in suggestions or reports.</li>
      </ul>
      <h2>Checks against fake ratings</h2>
      <p>
        Ratings may be stored but left out of public scores by our checks against fake or coordinated ratings. Excluded ratings can be appealed
        anonymously. A low score or criticism is never by itself a reason for exclusion.
      </p>
      <h2>No paid influence</h2>
      <p>
        No one can pay to change placement or scores, and we offer no “reputation clean-up”. Agencies may request factual directory corrections, but they
        cannot remove legitimate ratings.
      </p>
      <h2>Your wallet</h2>
      <p>
        You are responsible for keeping your recovery key. GovZones cannot recover it, and without it you may be unable to change or delete earlier
        anonymous ratings.
      </p>
      <h2>Changes</h2>
      <p>We will post important changes to these terms and to the scoring rules on this site, with the date of each change.</p>
    </article>
  );
}
