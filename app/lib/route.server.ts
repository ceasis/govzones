import { data, type RouterContextProvider } from "react-router";
import { webEnvContext } from "./context";
import { countryBySegment, type Country } from "./data.server";

export function envFrom(context: Readonly<RouterContextProvider>) {
  return context.get(webEnvContext).env;
}

/** Resolves an ACTIVE country from the URL segment or throws a 404. */
export async function requireCountry(context: Readonly<RouterContextProvider>, segment: string | undefined): Promise<Country> {
  const env = envFrom(context);
  const c = segment ? await countryBySegment(env.DIRECTORY, segment) : null;
  if (!c) throw data("Country not found", { status: 404 });
  if (c.status !== "ACTIVE") throw data(`${c.name} is not available yet`, { status: 404, statusText: `${c.name} is coming later` });
  return c;
}
