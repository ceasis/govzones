import { Link } from "react-router";
import type { Route } from "./+types/countries";
import { webEnvContext } from "../lib/context";
import { listCountries } from "../lib/data.server";

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(webEnvContext);
  return { countries: await listCountries(env.DIRECTORY) };
}

export const meta: Route.MetaFunction = () => [{ title: "Choose a country · GovZones" }];

export default function Countries({ loaderData }: Route.ComponentProps) {
  return (
    <div className="container-page max-w-xl py-8">
      <h1 className="text-2xl font-bold">Choose a country</h1>
      <p className="mt-2 text-muted">Each country has its own directory, rules and rankings. We never redirect you by location.</p>
      <ul className="mt-6 space-y-2">
        {loaderData.countries.map((c) => (
          <li key={c.code} className="card flex items-center justify-between gap-3">
            <span className="font-semibold">{c.name}</span>
            {c.status === "ACTIVE" ? (
              <Link className="btn-primary" to={`/${c.pathSegment}`}>
                Open
              </Link>
            ) : (
              <span className="text-sm text-muted">Coming later</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
