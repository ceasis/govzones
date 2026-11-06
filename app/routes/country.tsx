import { Outlet } from "react-router";
import type { Route } from "./+types/country";
import { requireCountry } from "../lib/route.server";

export async function loader({ context, params }: Route.LoaderArgs) {
  const country = await requireCountry(context, params.country);
  return { country };
}

export default function CountryLayout() {
  return <Outlet />;
}
