/**
 * GovZones public web Worker entry (govzones.com).
 * Order: dev gateway (local only) → public JSON API → robots/sitemap → React Router SSR.
 */
import { createRequestHandler, RouterContextProvider } from "react-router";
import { handleApi } from "./api";
import { webEnvContext } from "../../app/lib/context";
import type { WebEnv } from "./env";

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

/** Local development: *.govzones.localhost hosts map to the separately deployed Workers. */
async function devGateway(request: Request, env: WebEnv): Promise<Response | null> {
  if (env.DEV_GATEWAY !== "1" || env.ENVIRONMENT !== "development") return null;
  const url = new URL(request.url);
  const host = url.hostname;
  if (!host.endsWith("localhost")) return null;
  if (host.startsWith("accounts.") && env.DEV_ACCOUNTS) return env.DEV_ACCOUNTS.fetch(request);
  if (host.startsWith("vote.") && env.DEV_BALLOT) return env.DEV_BALLOT.fetch(request);
  if (host.startsWith("admin.") && env.DEV_ADMIN) return env.DEV_ADMIN.fetch(request);
  if (url.pathname === "/__dev/tick" && request.method === "POST") {
    // Stands in for production cron triggers: root publication, trust screening, maturation, rankings.
    const groups = await env.DEV_GROUP_OPS?.publishNow();
    const trust = await env.DEV_ACCOUNTS_ADMIN?.runTrustScreening();
    const groupsAfterTrust = await env.DEV_GROUP_OPS?.publishNow();
    const aggregates = await env.DEV_AGGREGATOR?.tick(true);
    return Response.json({ groups, trust, groupsAfterTrust, aggregates });
  }
  if (url.pathname === "/__dev/rebuild" && request.method === "POST") {
    return Response.json(await env.DEV_AGGREGATOR?.rebuildAll());
  }
  if (url.pathname === "/__dev/age" && request.method === "POST") {
    const body = (await request.json()) as { hours: number; lastScored?: boolean };
    return Response.json(await env.DEV_AGGREGATOR?.devAge(body.hours, { lastScored: body.lastScored }));
  }
  if (url.pathname === "/__dev/demo-ballots" && request.method === "POST") {
    const { action } = (await request.json()) as { action: "seed" | "clear" };
    return Response.json(action === "clear" ? await env.DEV_AGGREGATOR?.devClearDemo() : await env.DEV_AGGREGATOR?.devSeedDemo());
  }
  if (url.pathname === "/__dev/ballots" && request.method === "GET") {
    return Response.json(await env.DEV_AGGREGATOR?.devEntityBallots(url.searchParams.get("entity") ?? ""));
  }
  return null;
}

function robots(env: WebEnv): Response {
  const body =
    env.ENVIRONMENT === "production"
      ? `User-agent: *\nAllow: /\nDisallow: /me/\nDisallow: /sign-in\nSitemap: ${env.PUBLIC_ORIGIN}/sitemap.xml\n`
      : `User-agent: *\nDisallow: /\n`;
  return new Response(body, { headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=3600" } });
}

async function sitemap(env: WebEnv): Promise<Response> {
  const { results } = await env.DIRECTORY.prepare(
    `SELECT slug, type, updated_at FROM entities WHERE country_code = 'PH' AND status = 'ACTIVE' ORDER BY name LIMIT 45000`,
  ).all<{ slug: string; type: string; updated_at: string }>();
  const places = await env.DIRECTORY.prepare(
    `SELECT id FROM geo_units WHERE country_code = 'PH' AND type IN ('REGION', 'PROVINCE', 'CITY', 'MUNICIPALITY') ORDER BY sort_order, name LIMIT 2000`,
  ).all<{ id: string }>();
  const kind = (t: string) => (["AGENCY", "LGU", "OTHER_PUBLIC_BODY"].includes(t) ? "agency" : "office");
  const urls = [
    `${env.PUBLIC_ORIGIN}/ph`,
    `${env.PUBLIC_ORIGIN}/ph/rankings`,
    `${env.PUBLIC_ORIGIN}/ph/places`,
    `${env.PUBLIC_ORIGIN}/ph/methodology`,
    ...places.results.map((g) => `${env.PUBLIC_ORIGIN}/ph/places/${encodeURIComponent(g.id)}`),
    ...results.map((r) => `${env.PUBLIC_ORIGIN}/ph/${kind(r.type)}/${encodeURIComponent(r.slug)}`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${u}</loc></url>`)
    .join("\n")}\n</urlset>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" } });
}

export default {
  async fetch(request, env, ctx) {
    const gateway = await devGateway(request, env);
    if (gateway) return gateway;

    const url = new URL(request.url);
    if (env.ENVIRONMENT === "production" && url.hostname === "www.govzones.com") {
      return Response.redirect(`https://govzones.com${url.pathname}${url.search}`, 301);
    }
    if (url.pathname.startsWith("/api/v1/")) return handleApi(request, env);
    if (url.pathname === "/robots.txt") return robots(env);
    if (url.pathname === "/sitemap.xml") return sitemap(env);

    const context = new RouterContextProvider();
    context.set(webEnvContext, { env, ctx });
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<WebEnv>;
