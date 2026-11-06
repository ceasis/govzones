import { Link } from "react-router";
import type { Route } from "./+types/policy.corrections";

export const meta: Route.MetaFunction = () => [{ title: "Directory corrections policy · GovZones" }];

export default function CorrectionsPolicy() {
  return (
    <article className="container-page prose-civic max-w-3xl py-8">
      <h1 className="text-2xl font-bold">Directory corrections policy</h1>
      <h2>Sources</h2>
      <p>
        National agencies are seeded from public government information, with the Department of Budget and Management's Philippine Government Directory
        as the reference. Geography follows the Philippine Statistics Authority's Philippine Standard Geographic Code (PSGC). Branch offices come from
        each agency's own official directory. Listings marked “Not yet verified” have not yet been checked by a curator.
      </p>
      <h2>Reporting a problem</h2>
      <p>
        Anyone signed in can use “Report incorrect details” on a listing, or <Link to="/ph/suggest">suggest a missing office</Link>. Curators check the
        report against official sources. Verified corrections are applied promptly, and government source changes are reconciled at least quarterly.
      </p>
      <h2>Renames, moves, merges and closures</h2>
      <ul>
        <li>Every change is recorded in a log. Old web addresses keep working and lead to the new page.</li>
        <li>When duplicates are merged, the duplicate page points to the surviving listing. Ratings are never silently moved to a different office.</li>
        <li>Closed offices stop accepting ratings, but their history is kept.</li>
      </ul>
      <h2>Agencies</h2>
      <p>
        Agencies may request corrections to factual listing details. They cannot remove or alter legitimate ratings, see who rated them, or buy placement.
        GovZones uses no government insignia and links to official websites for reference only.
      </p>
    </article>
  );
}
