import type { MetaDescriptor } from "react-router";

/** Standard document metadata: title, description and share (Open Graph / Twitter) tags. */
export function pageMeta(opts: { title: string; description: string; noindex?: boolean; path?: string; origin?: string }): MetaDescriptor[] {
  const out: MetaDescriptor[] = [
    { title: opts.title },
    { name: "description", content: opts.description },
    { property: "og:site_name", content: "GovZones" },
    { property: "og:type", content: "website" },
    { property: "og:title", content: opts.title },
    { property: "og:description", content: opts.description },
    { name: "twitter:card", content: "summary" },
  ];
  if (opts.path && opts.origin) out.push({ property: "og:url", content: `${opts.origin}${opts.path}` }, { tagName: "link", rel: "canonical", href: `${opts.origin}${opts.path}` });
  if (opts.noindex) out.push({ name: "robots", content: "noindex" });
  return out;
}
