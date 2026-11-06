/** Public, read-only /api/v1 JSON API served from govzones.com. */
import {
  countryBySegment,
  decodeCursor,
  entityById,
  geoChildren,
  listCountries,
  parseCohort,
  parsePeriod,
  rankings,
  searchEntities,
  typesForScope,
} from "../../app/lib/data.server";
import { isUuid } from "../../shared/protocol";
import { HttpError, errorResponse, json } from "../../shared/http";
import type { WebEnv } from "./env";

const PUBLIC_CACHE = { "Cache-Control": "public, max-age=60, s-maxage=60", "Access-Control-Allow-Origin": "*" };

async function countryParam(env: WebEnv, url: URL): Promise<string> {
  const code = (url.searchParams.get("country") ?? "PH").toUpperCase();
  const c = await countryBySegment(env.DIRECTORY, code.toLowerCase());
  if (!c || c.status !== "ACTIVE") throw new HttpError("NOT_FOUND", "Unknown or inactive country.");
  return c.code;
}

export async function handleApi(request: Request, env: WebEnv): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith("/api/v1/groups/")) {
      if (request.method !== "GET") throw new HttpError("METHOD_NOT_ALLOWED");
      // Public group roots/snapshots are served by the Group Manager; no ballot or account data involved.
      const res = await env.GROUPS_PUBLIC.fetch(new Request(url.toString(), { method: "GET" }));
      return new Response(res.body, res);
    }
    if (request.method !== "GET") throw new HttpError("METHOD_NOT_ALLOWED");
    const p = url.pathname;

    if (p === "/api/v1/countries") {
      const countries = await listCountries(env.DIRECTORY);
      return json({ default: "PH", countries }, {}, PUBLIC_CACHE);
    }
    if (p === "/api/v1/geographies") {
      const country = await countryParam(env, url);
      const items = await geoChildren(env.DIRECTORY, country, url.searchParams.get("parent"), url.searchParams.get("type") ?? undefined);
      return json({ country, items }, {}, { ...PUBLIC_CACHE, "Cache-Control": "public, max-age=3600" });
    }
    if (p === "/api/v1/entities") {
      const country = await countryParam(env, url);
      const offset = decodeCursor(url.searchParams.get("cursor"));
      const geo = url.searchParams.get("geo");
      const result = await searchEntities(env.DIRECTORY, {
        country,
        q: (url.searchParams.get("q") ?? "").slice(0, 120),
        types: typesForScope(url.searchParams.get("scope"), url.searchParams.get("type")),
        regionId: url.searchParams.get("region") ?? (geo?.startsWith("r-") ? geo : null),
        provinceId: url.searchParams.get("province") ?? (geo?.startsWith("p-") ? geo : null),
        cityId: url.searchParams.get("city") ?? (geo && /^[cm]-/.test(geo) ? geo : null),
        minVotes: Number(url.searchParams.get("min") ?? 0) || 0,
        offset,
        limit: Number(url.searchParams.get("limit") ?? 20) || 20,
      });
      return json({ country, ...result }, {}, PUBLIC_CACHE);
    }
    const ent = p.match(/^\/api\/v1\/entities\/([0-9a-f-]{36})(\/score)?$/);
    if (ent) {
      if (!isUuid(ent[1])) throw new HttpError("NOT_FOUND");
      const entity = await entityById(env.DIRECTORY, ent[1]);
      if (!entity) throw new HttpError("NOT_FOUND");
      if (ent[2]) {
        const period = parsePeriod(url.searchParams.get("period"));
        return json({ entityId: entity.id, ...entity.scores[period] }, {}, PUBLIC_CACHE);
      }
      return json(entity, {}, PUBLIC_CACHE);
    }
    if (p === "/api/v1/rankings") {
      const country = await countryParam(env, url);
      const kindParam = url.searchParams.get("kind");
      const kind = kindParam === "lowest" ? "lowest" : kindParam === "most" ? "most" : "best";
      const view = await rankings(env.PUBLIC_CACHE, country, {
        cohort: parseCohort(url.searchParams.get("type")),
        period: parsePeriod(url.searchParams.get("period")),
        kind,
        regionId: url.searchParams.get("region"),
        provinceId: url.searchParams.get("province"),
        cityId: url.searchParams.get("city"),
        offset: decodeCursor(url.searchParams.get("cursor")),
        limit: Number(url.searchParams.get("limit") ?? 25) || 25,
      });
      return json(
        { country, ...view, disclaimer: "User-generated perceptions, not official performance audits." },
        {},
        PUBLIC_CACHE,
      );
    }
    throw new HttpError("NOT_FOUND");
  } catch (err) {
    return errorResponse(err, { "Access-Control-Allow-Origin": "*" });
  }
}
