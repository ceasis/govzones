import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  index("routes/root-redirect.tsx"),
  route("countries", "routes/countries.tsx"),
  route("sign-in", "routes/sign-in.tsx"),
  ...prefix("me", [
    route("ratings", "routes/me.ratings.tsx"),
    route("wallet", "routes/me.wallet.tsx"),
    route("account", "routes/me.account.tsx"),
  ]),
  route("privacy", "routes/privacy.tsx"),
  route("terms", "routes/terms.tsx"),
  route("about", "routes/about.tsx"),
  route("policies/corrections", "routes/policy.corrections.tsx"),
  route("policies/appeals", "routes/policy.appeals.tsx"),
  route(":country", "routes/country.tsx", [
    index("routes/home.tsx"),
    route("search", "routes/search.tsx"),
    route("rankings", "routes/rankings.tsx"),
    route("places", "routes/places.tsx"),
    route("places/:id", "routes/place.tsx"),
    route("agency/:slug", "routes/entity.tsx", { id: "entity-agency" }),
    route("office/:slug", "routes/entity.tsx", { id: "entity-office" }),
    route("methodology", "routes/methodology.tsx"),
    route("transparency", "routes/transparency.tsx"),
    route("suggest", "routes/suggest.tsx"),
  ]),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
