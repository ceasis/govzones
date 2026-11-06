/**
 * GovZones internal administration (admin.govzones.com), behind Cloudflare Access + MFA.
 *
 * Separation of duties: this Worker binds the public directory DB directly, but reaches
 * ballots and enrollments ONLY through narrow RPC entrypoints. It has no votes or
 * identity database binding and therefore no way to join the two.
 */
import type { BallotModeration } from "../ballot/moderation";
import type { AccountsAdmin } from "../accounts/index";
import type { GroupOps } from "../groups/index";
import type { AggregatorOps } from "../aggregator/index";
import { ENTITY_TYPES, ENTITY_TYPE_LABEL, isEntityType, normalizeText, slugify, entityPath } from "../../shared/directory";
import { GEO_ANCESTORS_SQL, REBUILD_SEARCH_ROW_SQL, ancestorsFrom } from "../../shared/search-sql";
import { nowIso } from "../../shared/http";
import { authenticate, ROLES, type AdminAuthEnv, type Role, type Staff } from "./auth";

export interface Env extends AdminAuthEnv {
  DIRECTORY: D1Database;
  BALLOT_MOD: Service<BallotModeration>;
  ACCOUNTS_ADMIN: Service<AccountsAdmin>;
  GROUP_OPS: Service<GroupOps>;
  AGGREGATOR: Service<AggregatorOps>;
  ADMIN_ORIGIN: string;
  PUBLIC_ORIGIN: string;
}

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(staff: Staff, title: string, body: string, status = 200): Response {
  const nav = [
    ["/", "Dashboard", null],
    ["/directory/suggestions", "Suggestions", "curator"],
    ["/directory/corrections", "Corrections", "curator"],
    ["/directory/entities", "Entities", "curator"],
    ["/moderation/cases", "Ballot cases", "moderator"],
    ["/trust", "Enrollment trust", "moderator"],
    ["/ops", "Operations", "sysadmin"],
    ["/audit", "Audit", null],
  ]
    .filter(([, , role]) => !role || staff.roles.includes(role as Role))
    .map(([href, label]) => `<a href="${href}">${label}</a>`)
    .join("");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · GovZones admin</title><meta name="robots" content="noindex,nofollow">
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#0f172a;background:#f8fafc}
header{background:#0f172a;color:#fff;padding:.75rem 1rem}header strong{margin-right:1rem}
nav{display:flex;flex-wrap:wrap;gap:.25rem .75rem;padding:.5rem 1rem;background:#e2e8f0}nav a{color:#0f172a}
main{padding:1rem;max-width:72rem;margin:0 auto}table{border-collapse:collapse;width:100%;background:#fff}
td,th{border:1px solid #cbd5e1;padding:.4rem .5rem;text-align:left;vertical-align:top}th{background:#f1f5f9}
.card{background:#fff;border:1px solid #cbd5e1;border-radius:.5rem;padding:1rem;margin:0 0 1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1rem}
input,select,textarea{font:inherit;padding:.4rem;border:1px solid #64748b;border-radius:.375rem;max-width:100%}
textarea{width:100%;min-height:4rem}button{font:inherit;padding:.4rem .8rem;border-radius:.375rem;border:1px solid #0f172a;background:#0f172a;color:#fff;cursor:pointer;min-height:36px}
button.secondary{background:#fff;color:#0f172a}.warn{background:#fef3c7;border:1px solid #b45309;padding:.75rem;border-radius:.5rem}
.muted{color:#475569}.wrap{overflow-x:auto}label{display:block;font-weight:600;margin-top:.5rem}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
</style></head><body>
<header><strong>GovZones admin</strong><span>${esc(staff.ref)} · roles: ${esc(staff.roles.join(", "))}${staff.dev ? " · <em>development bypass</em>" : ""}</span></header>
<nav>${nav}</nav><main><h1>${esc(title)}</h1>${body}</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

const redirect = (to: string) => new Response(null, { status: 303, headers: { Location: to } });

function need(staff: Staff, role: Role) {
  if (!staff.roles.includes(role) && !staff.roles.includes("sysadmin")) throw new Forbidden();
}
class Forbidden extends Error {}

async function audit(env: Env, staff: Staff, role: Role, action: string, entityId: string | null, summary: unknown, caseRef?: string) {
  await env.DIRECTORY.prepare(
    `INSERT INTO directory_audit (id, action, entity_id, actor_role, actor_ref, case_ref, created_at, change_summary)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(crypto.randomUUID(), action, entityId, role, staff.ref, caseRef ?? null, nowIso(), JSON.stringify(summary))
    .run();
}

async function rebuildSearch(env: Env, entityId: string) {
  await env.DIRECTORY.batch(REBUILD_SEARCH_ROW_SQL.map((sql) => env.DIRECTORY.prepare(sql).bind(entityId)));
}

async function geoAncestors(env: Env, geoId: string | null) {
  if (!geoId) return { regionId: null, provinceId: null, cityId: null };
  const { results } = await env.DIRECTORY.prepare(GEO_ANCESTORS_SQL).bind(geoId).all<{ id: string; type: string }>();
  return ancestorsFrom(results);
}

async function wouldCycle(env: Env, entityId: string, parentId: string | null): Promise<boolean> {
  let cursor = parentId;
  for (let i = 0; cursor && i < 20; i++) {
    if (cursor === entityId) return true;
    const row = await env.DIRECTORY.prepare(`SELECT parent_entity_id FROM entities WHERE id = ?1`).bind(cursor).first<{ parent_entity_id: string | null }>();
    cursor = row?.parent_entity_id ?? null;
  }
  return false;
}

async function uniqueSlug(env: Env, country: string, base: string, selfId?: string) {
  let slug = slugify(base) || "entity";
  for (let i = 2; i < 100; i++) {
    const clash = await env.DIRECTORY.prepare(
      `SELECT entity_id FROM (SELECT id AS entity_id FROM entities WHERE country_code = ?1 AND slug = ?2
         UNION SELECT entity_id FROM entity_slug_history WHERE country_code = ?1 AND slug = ?2)`,
    )
      .bind(country, slug)
      .first<{ entity_id: string }>();
    if (!clash || clash.entity_id === selfId) return slug;
    slug = `${slugify(base)}-${i}`;
  }
  return `${slugify(base)}-${crypto.randomUUID().slice(0, 6)}`;
}

/* ------------------------------------------------------------------ */

async function dashboard(env: Env, staff: Staff) {
  const counts = await env.DIRECTORY.prepare(
    `SELECT (SELECT COUNT(*) FROM entity_suggestions WHERE status = 'NEW') AS suggestions,
            (SELECT COUNT(*) FROM entity_corrections WHERE status = 'NEW') AS corrections,
            (SELECT COUNT(*) FROM entities WHERE status = 'ACTIVE') AS entities,
            (SELECT COUNT(*) FROM entities WHERE status = 'ACTIVE' AND verified_at IS NULL) AS unverified`,
  ).first<Record<string, number>>();
  let transparency: Record<string, unknown> = {};
  if (staff.roles.includes("moderator") || staff.roles.includes("sysadmin")) transparency = (await env.BALLOT_MOD.transparency()) as unknown as Record<string, unknown>;
  const body = `
  <div class="grid">
    <div class="card"><strong>${counts?.suggestions ?? 0}</strong> new suggestions</div>
    <div class="card"><strong>${counts?.corrections ?? 0}</strong> new correction reports</div>
    <div class="card"><strong>${counts?.entities ?? 0}</strong> active listings (${counts?.unverified ?? 0} not yet source-verified)</div>
  </div>
  ${
    Object.keys(transparency).length
      ? `<div class="card"><h2>Ballot integrity (aggregate only)</h2><pre>${esc(JSON.stringify(transparency, null, 2))}</pre></div>`
      : ""
  }
  <div class="warn">Staff can never create, edit or reassign individual votes, and can never link a ballot to an account.
  Low scores or criticism are never, on their own, a reason to withhold a rating.</div>
  ${staff.dev ? devRolePicker(staff) : ""}`;
  return page(staff, "Dashboard", body);
}

function devRolePicker(staff: Staff) {
  return `<div class="card"><h2>Development role switcher</h2><form method="post" action="/__dev/roles" class="row">
  ${ROLES.map((r) => `<label style="font-weight:400"><input type="checkbox" name="role" value="${r}" ${staff.roles.includes(r) ? "checked" : ""}> ${r}</label>`).join("")}
  <button type="submit">Apply</button></form></div>`;
}

/* Directory: suggestions ------------------------------------------- */

async function suggestions(env: Env, staff: Staff) {
  need(staff, "curator");
  const { results } = await env.DIRECTORY.prepare(
    `SELECT * FROM entity_suggestions WHERE status IN ('NEW', 'IN_REVIEW') ORDER BY created_at LIMIT 100`,
  ).all<Record<string, string>>();
  const rows = results
    .map(
      (s) => `<tr><td>${esc(s.suggested_name)}<div class="muted">${esc(s.suggested_type)} · ${esc(s.geo_unit_id ?? "")}</div>
      <div class="muted">${esc(s.address ?? "")}</div><div>${esc(s.notes ?? "")}</div></td>
      <td><a href="${esc(s.source_url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(s.source_url)}</a></td>
      <td>${esc(s.created_at.slice(0, 10))}</td>
      <td><form method="post" action="/directory/suggestions/${esc(s.id)}">
        <label>Official name<input name="name" value="${esc(s.suggested_name)}" required></label>
        <label>Type<select name="type">${ENTITY_TYPES.map((t) => `<option ${t === s.suggested_type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label>Parent entity id<input name="parent" value="${esc(s.parent_entity_id ?? "")}"></label>
        <label>Geo unit id<input name="geo" value="${esc(s.geo_unit_id ?? "")}"></label>
        <label>Note<input name="note"></label>
        <div class="row" style="margin-top:.5rem"><button name="decision" value="ACCEPT">Accept &amp; publish</button>
        <button class="secondary" name="decision" value="DUPLICATE">Duplicate</button>
        <button class="secondary" name="decision" value="REJECT">Reject</button></div></form></td></tr>`,
    )
    .join("");
  return page(
    staff,
    "Suggested listings",
    `<p class="muted">Validate the agency relationship, the official source, the address and duplicates before publishing.</p>
     <div class="wrap"><table><tr><th>Suggestion</th><th>Source</th><th>Received</th><th>Decision</th></tr>${rows || `<tr><td colspan="4">No pending suggestions.</td></tr>`}</table></div>`,
  );
}

async function resolveSuggestion(env: Env, staff: Staff, id: string, form: FormData) {
  need(staff, "curator");
  const s = await env.DIRECTORY.prepare(`SELECT * FROM entity_suggestions WHERE id = ?1`).bind(id).first<Record<string, string>>();
  if (!s || !["NEW", "IN_REVIEW"].includes(s.status)) return redirect("/directory/suggestions");
  const decision = String(form.get("decision"));
  const note = String(form.get("note") ?? "").slice(0, 500);
  if (decision !== "ACCEPT") {
    await env.DIRECTORY.prepare(`UPDATE entity_suggestions SET status = ?1, resolution_note = ?2, reviewed_at = ?3 WHERE id = ?4`)
      .bind(decision === "DUPLICATE" ? "DUPLICATE" : "REJECTED", note, nowIso(), id)
      .run();
    await audit(env, staff, "curator", `SUGGESTION_${decision}`, null, { suggestion: id });
    return redirect("/directory/suggestions");
  }
  const name = String(form.get("name") ?? "").trim().slice(0, 200);
  const type = String(form.get("type"));
  if (!name || !isEntityType(type)) return redirect("/directory/suggestions");
  const parent = String(form.get("parent") ?? "").trim() || null;
  const geo = String(form.get("geo") ?? "").trim() || null;
  const entityId = crypto.randomUUID();
  const slug = await uniqueSlug(env, s.country_code, name);
  const anc = await geoAncestors(env, geo);
  const ts = nowIso();
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(
      `INSERT INTO entities (id, country_code, type, parent_entity_id, geo_unit_id, region_id, province_id, city_id, name, normalized_name,
         slug, address, status, ratable, verified_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'ACTIVE', ?13, ?14, ?14, ?14)`,
    ).bind(entityId, s.country_code, type, parent, geo, anc.regionId, anc.provinceId, anc.cityId, name, normalizeText(name), slug, s.address ?? null,
      type === "BARANGAY_OFFICE" || type === "OTHER_PUBLIC_BODY" ? 1 : 1, ts),
    env.DIRECTORY.prepare(
      `INSERT INTO entity_sources (id, entity_id, source_url, publisher, checked_at, status, note) VALUES (?1, ?2, ?3, 'Citizen suggestion source', ?4, 'CURRENT', 'Checked by curator at publication')`,
    ).bind(crypto.randomUUID(), entityId, s.source_url, ts),
    env.DIRECTORY.prepare(`UPDATE entity_suggestions SET status = 'ACCEPTED', resulting_entity_id = ?1, reviewed_at = ?2, resolution_note = ?3 WHERE id = ?4`).bind(entityId, ts, note, id),
  ]);
  await rebuildSearch(env, entityId);
  await audit(env, staff, "curator", "ENTITY_CREATED_FROM_SUGGESTION", entityId, { suggestion: id, name, type });
  return redirect(`/directory/entities/${entityId}`);
}

/* Directory: corrections ------------------------------------------- */

async function corrections(env: Env, staff: Staff) {
  need(staff, "curator");
  const { results } = await env.DIRECTORY.prepare(
    `SELECT c.*, e.name, e.slug, e.type FROM entity_corrections c JOIN entities e ON e.id = c.entity_id
      WHERE c.status = 'NEW' ORDER BY c.created_at LIMIT 100`,
  ).all<Record<string, string>>();
  const rows = results
    .map(
      (c) => `<tr><td><a href="/directory/entities/${esc(c.entity_id)}">${esc(c.name)}</a></td><td>${esc(c.field)}</td>
      <td>${esc(c.details)}${c.source_url ? `<div><a href="${esc(c.source_url)}" rel="noopener noreferrer nofollow" target="_blank">source</a></div>` : ""}</td>
      <td><form method="post" action="/directory/corrections/${esc(c.id)}" class="row"><input name="note" placeholder="Resolution note">
      <button name="decision" value="ACCEPTED">Applied</button><button class="secondary" name="decision" value="REJECTED">Reject</button></form></td></tr>`,
    )
    .join("");
  return page(
    staff,
    "Correction reports",
    `<p class="muted">Apply verified corrections on the entity page, then mark the report resolved. Agencies may correct facts but can never remove ratings.</p>
     <div class="wrap"><table><tr><th>Listing</th><th>Field</th><th>Report</th><th>Resolve</th></tr>${rows || `<tr><td colspan="4">No open reports.</td></tr>`}</table></div>`,
  );
}

async function resolveCorrection(env: Env, staff: Staff, id: string, form: FormData) {
  need(staff, "curator");
  const decision = String(form.get("decision")) === "ACCEPTED" ? "ACCEPTED" : "REJECTED";
  const row = await env.DIRECTORY.prepare(`SELECT entity_id FROM entity_corrections WHERE id = ?1`).bind(id).first<{ entity_id: string }>();
  await env.DIRECTORY.prepare(`UPDATE entity_corrections SET status = ?1, resolution_note = ?2, reviewed_at = ?3 WHERE id = ?4`)
    .bind(decision, String(form.get("note") ?? "").slice(0, 500), nowIso(), id)
    .run();
  await audit(env, staff, "curator", `CORRECTION_${decision}`, row?.entity_id ?? null, { correction: id });
  return redirect("/directory/corrections");
}

/* Directory: entities ---------------------------------------------- */

async function entities(env: Env, staff: Staff, url: URL) {
  need(staff, "curator");
  const q = (url.searchParams.get("q") ?? "").trim();
  const { results } = await env.DIRECTORY.prepare(
    `SELECT id, name, acronym, type, status, verified_at FROM entities
      WHERE (?1 = '' OR normalized_name LIKE '%' || ?1 || '%' OR lower(acronym) = ?1) ORDER BY name LIMIT 100`,
  )
    .bind(normalizeText(q))
    .all<Record<string, string>>();
  const rows = results
    .map(
      (e) => `<tr><td><a href="/directory/entities/${esc(e.id)}">${esc(e.name)}</a> ${e.acronym ? `(${esc(e.acronym)})` : ""}</td>
      <td>${esc(e.type)}</td><td>${esc(e.status)}</td><td>${e.verified_at ? esc(e.verified_at.slice(0, 10)) : "<em>not verified</em>"}</td></tr>`,
    )
    .join("");
  return page(
    staff,
    "Directory entities",
    `<form class="row" method="get"><input name="q" value="${esc(q)}" placeholder="Search name or acronym"><button>Search</button></form>
     <div class="wrap"><table><tr><th>Name</th><th>Type</th><th>Status</th><th>Verified</th></tr>${rows}</table></div>`,
  );
}

async function entityEditor(env: Env, staff: Staff, id: string, saved = false) {
  need(staff, "curator");
  const e = await env.DIRECTORY.prepare(`SELECT * FROM entities WHERE id = ?1`).bind(id).first<Record<string, string | number | null>>();
  if (!e) return page(staff, "Not found", "<p>No such entity.</p>", 404);
  const aliases = await env.DIRECTORY.prepare(`SELECT id, alias, kind FROM entity_aliases WHERE entity_id = ?1`).bind(id).all<Record<string, string>>();
  const sources = await env.DIRECTORY.prepare(`SELECT * FROM entity_sources WHERE entity_id = ?1`).bind(id).all<Record<string, string>>();
  const history = await env.DIRECTORY.prepare(`SELECT * FROM directory_audit WHERE entity_id = ?1 ORDER BY created_at DESC LIMIT 20`).bind(id).all<Record<string, string>>();
  const publicUrl = `${env.PUBLIC_ORIGIN}${entityPath("ph", e.type as never, String(e.slug))}`;
  const field = (name: string, label: string, value: unknown) =>
    `<label>${label}<input name="${name}" value="${esc(value ?? "")}" style="width:100%"></label>`;
  const body = `${saved ? `<div class="warn">Saved.</div>` : ""}
  <p><a href="${esc(publicUrl)}" target="_blank" rel="noopener">View public page</a> · id <code>${esc(e.id)}</code></p>
  <div class="grid"><form method="post" action="/directory/entities/${esc(id)}" class="card">
    <input type="hidden" name="op" value="update">
    ${field("name", "Official name", e.name)}${field("acronym", "Acronym", e.acronym)}
    <label>Type<select name="type">${ENTITY_TYPES.map((t) => `<option value="${t}" ${t === e.type ? "selected" : ""}>${t} — ${ENTITY_TYPE_LABEL[t]}</option>`).join("")}</select></label>
    ${field("parent", "Parent entity id", e.parent_entity_id)}${field("geo", "Geo unit id", e.geo_unit_id)}
    ${field("official_url", "Official URL", e.official_url)}${field("address", "Address (source-backed only)", e.address)}
    <label>Description<textarea name="description">${esc(e.description ?? "")}</textarea></label>
    ${field("slug", "Slug (old slugs keep redirecting)", e.slug)}
    <label>Status<select name="status">${["ACTIVE", "PENDING", "CLOSED", "HIDDEN", "MERGED"].map((s) => `<option ${s === e.status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
    ${field("merged_into", "Merged into entity id (status MERGED only; votes are NOT transferred)", e.merged_into_id)}
    <label><input type="checkbox" name="ratable" value="1" ${e.ratable ? "checked" : ""} style="width:auto"> Ratable</label>
    <label><input type="checkbox" name="verify_now" value="1" style="width:auto"> Mark directory-verified today (sources checked)</label>
    <label>Change reason / case reference<input name="reason" required style="width:100%"></label>
    <p><button>Save changes</button></p>
  </form>
  <div>
    <div class="card"><h2>Aliases</h2><ul>${aliases.results.map((a) => `<li>${esc(a.alias)} <span class="muted">${esc(a.kind)}</span>
      <form method="post" action="/directory/entities/${esc(id)}" style="display:inline"><input type="hidden" name="op" value="remove_alias"><input type="hidden" name="alias_id" value="${esc(a.id)}"><button class="secondary">Remove</button></form></li>`).join("")}</ul>
      <form method="post" action="/directory/entities/${esc(id)}" class="row"><input type="hidden" name="op" value="add_alias"><input name="alias" placeholder="New alias" required>
      <select name="kind"><option>ALIAS</option><option>ACRONYM</option><option>FORMER_NAME</option><option>LOCAL_NAME</option></select><button>Add</button></form></div>
    <div class="card"><h2>Sources</h2><ul>${sources.results.map((s) => `<li><a href="${esc(s.source_url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(s.publisher)}</a> — ${esc(s.status)} ${s.checked_at ? esc(s.checked_at.slice(0, 10)) : ""}</li>`).join("")}</ul>
      <form method="post" action="/directory/entities/${esc(id)}"><input type="hidden" name="op" value="add_source">
      <input name="source_url" placeholder="https://… official source" required style="width:100%"><input name="publisher" placeholder="Publisher" required style="width:100%">
      <p><button>Add checked source</button></p></form></div>
    <div class="card"><h2>History</h2><ul>${history.results.map((h) => `<li>${esc(h.created_at.slice(0, 16))} ${esc(h.action)} by ${esc(h.actor_ref)}</li>`).join("")}</ul></div>
  </div></div>`;
  return page(staff, String(e.name), body);
}

async function updateEntity(env: Env, staff: Staff, id: string, form: FormData) {
  need(staff, "curator");
  const op = String(form.get("op"));
  const ts = nowIso();
  const e = await env.DIRECTORY.prepare(`SELECT * FROM entities WHERE id = ?1`).bind(id).first<Record<string, string | null>>();
  if (!e) return redirect("/directory/entities");
  if (op === "add_alias") {
    const alias = String(form.get("alias") ?? "").trim().slice(0, 120);
    const kind = ["ALIAS", "ACRONYM", "FORMER_NAME", "LOCAL_NAME"].includes(String(form.get("kind"))) ? String(form.get("kind")) : "ALIAS";
    if (alias) {
      await env.DIRECTORY.prepare(`INSERT INTO entity_aliases (id, entity_id, alias, normalized_alias, kind) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING`)
        .bind(crypto.randomUUID(), id, alias, normalizeText(alias), kind)
        .run();
      await audit(env, staff, "curator", "ALIAS_ADDED", id, { alias, kind });
    }
  } else if (op === "remove_alias") {
    await env.DIRECTORY.prepare(`DELETE FROM entity_aliases WHERE id = ?1 AND entity_id = ?2`).bind(String(form.get("alias_id")), id).run();
    await audit(env, staff, "curator", "ALIAS_REMOVED", id, { aliasId: String(form.get("alias_id")) });
  } else if (op === "add_source") {
    const url = String(form.get("source_url") ?? "");
    try {
      if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
    } catch {
      return redirect(`/directory/entities/${id}`);
    }
    await env.DIRECTORY.prepare(`INSERT INTO entity_sources (id, entity_id, source_url, publisher, checked_at, status) VALUES (?1, ?2, ?3, ?4, ?5, 'CURRENT')`)
      .bind(crypto.randomUUID(), id, url, String(form.get("publisher") ?? "").slice(0, 120), ts)
      .run();
    await audit(env, staff, "curator", "SOURCE_ADDED", id, { url });
  } else if (op === "update") {
    const name = String(form.get("name") ?? "").trim().slice(0, 200);
    const type = String(form.get("type"));
    const status = String(form.get("status"));
    if (!name || !isEntityType(type) || !["ACTIVE", "PENDING", "CLOSED", "HIDDEN", "MERGED"].includes(status)) return redirect(`/directory/entities/${id}`);
    const parent = String(form.get("parent") ?? "").trim() || null;
    if (await wouldCycle(env, id, parent)) return page(staff, "Rejected", "<p>That parent would create a cycle in the hierarchy.</p>", 400);
    const geo = String(form.get("geo") ?? "").trim() || null;
    const mergedInto = status === "MERGED" ? String(form.get("merged_into") ?? "").trim() || null : null;
    const anc = await geoAncestors(env, geo);
    const slug = await uniqueSlug(env, String(e.country_code), String(form.get("slug") || name), id);
    const stmts: D1PreparedStatement[] = [];
    if (slug !== e.slug) {
      stmts.push(
        env.DIRECTORY.prepare(`INSERT INTO entity_slug_history (country_code, slug, entity_id, retired_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING`).bind(e.country_code, e.slug, id, ts),
      );
    }
    stmts.push(
      env.DIRECTORY.prepare(
        `UPDATE entities SET name = ?1, normalized_name = ?2, acronym = ?3, type = ?4, parent_entity_id = ?5, geo_unit_id = ?6,
           region_id = ?7, province_id = ?8, city_id = ?9, official_url = ?10, address = ?11, description = ?12, slug = ?13,
           status = ?14, merged_into_id = ?15, ratable = ?16, verified_at = CASE WHEN ?17 = 1 THEN ?18 ELSE verified_at END, updated_at = ?18
         WHERE id = ?19`,
      ).bind(
        name,
        normalizeText(name),
        String(form.get("acronym") ?? "").trim() || null,
        type,
        parent,
        geo,
        anc.regionId,
        anc.provinceId,
        anc.cityId,
        String(form.get("official_url") ?? "").trim() || null,
        String(form.get("address") ?? "").trim() || null,
        String(form.get("description") ?? "").trim().slice(0, 400) || null,
        slug,
        status,
        mergedInto,
        form.get("ratable") === "1" && status === "ACTIVE" ? 1 : 0,
        form.get("verify_now") === "1" ? 1 : 0,
        ts,
        id,
      ),
    );
    await env.DIRECTORY.batch(stmts);
    const changed = Object.fromEntries(
      ["name", "acronym", "type", "status", "official_url", "address"].filter((k) => String(form.get(k) ?? "") !== String(e[k] ?? "")).map((k) => [k, { from: e[k], to: form.get(k) }]),
    );
    await audit(env, staff, "curator", "ENTITY_UPDATED", id, { reason: String(form.get("reason") ?? "").slice(0, 300), changed, slug: slug !== e.slug ? { from: e.slug, to: slug } : undefined });
  }
  await rebuildSearch(env, id);
  return redirect(`/directory/entities/${id}?saved=1`);
}

/* Moderation ------------------------------------------------------- */

async function cases(env: Env, staff: Staff, url: URL) {
  need(staff, "moderator");
  const state = url.searchParams.get("state") || "OPEN";
  const list = (await env.BALLOT_MOD.listCases(state === "ALL" ? null : state, 100)) as Array<Record<string, string | number>>;
  const rows = list
    .map(
      (c) => `<tr><td><code>${esc(c.case_id)}</code><div class="muted">${esc(c.opened_by)}</div></td>
      <td><a href="/moderation/entity/${esc(c.entity_id)}">${esc(String(c.entity_id).slice(0, 8))}…</a></td>
      <td>${esc(c.reason_codes)}</td><td>${esc(c.state)} / ballot ${esc(c.ballot_status)}</td><td>${esc(c.score)} (${esc(c.trust_group)})</td>
      <td>${["OPEN", "APPEALED", "EXCLUDED"].includes(String(c.state)) ? `<form method="post" action="/moderation/cases/${esc(c.case_id)}" class="row"><input name="note" placeholder="Evidence-based note" required>
        <button name="decision" value="CLEAR">Clear</button><button class="secondary" name="decision" value="EXCLUDE">Exclude</button></form>` : esc(c.resolution_note ?? "")}</td></tr>`,
    )
    .join("");
  return page(
    staff,
    "Anonymous ballot cases",
    `<div class="warn">Cases contain ballot-level evidence only. There is no account information here and none can be requested.
     A low score or criticism of an agency is never sufficient evidence.</div>
     <p class="row">${["OPEN", "APPEALED", "EXCLUDED", "CLEARED", "ALL"].map((s) => `<a href="?state=${s}">${s}</a>`).join(" · ")}</p>
     <div class="wrap"><table><tr><th>Case</th><th>Entity</th><th>Evidence</th><th>State</th><th>Score</th><th>Action</th></tr>${rows || `<tr><td colspan="6">No cases.</td></tr>`}</table></div>`,
  );
}

async function entityBallots(env: Env, staff: Staff, entityId: string) {
  need(staff, "moderator");
  const ballots = (await env.BALLOT_MOD.entityBallots(entityId, 200)) as Array<Record<string, string | number>>;
  const rows = ballots
    .map((b) => `<tr><td><input type="checkbox" name="ballot" value="${esc(b.id)}" aria-label="Select ballot"></td><td>${esc(b.score)}</td><td>${esc(b.status)}</td><td>${esc(b.trust_group)}</td><td>${esc(String(b.held_since).slice(0, 16))}</td><td>${esc(b.revision)}</td></tr>`)
    .join("");
  return page(
    staff,
    "Ballots for entity",
    `<p class="muted">Entity <code>${esc(entityId)}</code>. Shows ballot-level fields only (no nullifiers).</p>
     <form method="post" action="/moderation/entity/${esc(entityId)}/quarantine"><div class="wrap"><table>
     <tr><th></th><th>Score</th><th>Status</th><th>Proof group</th><th>Held since</th><th>Revision</th></tr>${rows}</table></div>
     <label>Evidence categories (at least one besides staff review is expected)</label>
     ${["BURST_ON_ENTITY", "COORDINATED_TIMING", "UNIFORM_SCORE_CAMPAIGN", "REPEATED_CHANGE_ATTEMPTS", "STAFF_REVIEW"].map((r) => `<label style="font-weight:400"><input type="checkbox" name="reason" value="${r}"> ${r}</label>`).join("")}
     <p><button>Quarantine selected (withhold pending review)</button></p></form>`,
  );
}

/* Trust & ops ------------------------------------------------------ */

async function trust(env: Env, staff: Staff) {
  need(staff, "moderator");
  const [stats, resets, risks] = await Promise.all([
    env.ACCOUNTS_ADMIN.stats(),
    env.ACCOUNTS_ADMIN.listResetRequests() as Promise<Array<Record<string, string>>>,
    env.ACCOUNTS_ADMIN.listRiskActions() as Promise<Array<Record<string, string>>>,
  ]);
  return page(
    staff,
    "Enrollment trust",
    `<div class="warn">Enrollment-side screening never sees agencies, scores or nullifiers. Holding an account in the Submit Group
     only affects its FUTURE countable proofs; past anonymous ballots cannot be located by account.</div>
     <div class="card"><h2>Aggregate figures</h2><pre>${esc(JSON.stringify(stats, null, 2))}</pre></div>
     <div class="card"><h2>Wallet reset requests</h2><table><tr><th>Request</th><th>Country</th><th>Status</th><th>Day</th><th></th></tr>
     ${resets.map((r) => `<tr><td><code>${esc(r.id.slice(0, 8))}</code></td><td>${esc(r.country_code)}</td><td>${esc(r.status)}</td><td>${esc(r.created_day)}</td>
       <td>${r.status === "PENDING" ? `<form method="post" action="/trust/resets/${esc(r.id)}" class="row"><button name="approve" value="1">Approve (new credential stays submit-only)</button><button class="secondary" name="approve" value="0">Reject</button></form>` : esc(r.case_ref ?? "")}</td></tr>`).join("")}</table></div>
     <div class="card"><h2>Risk actions</h2><table><tr><th>Case</th><th>Reason</th><th>Action</th><th>Expires</th><th></th></tr>
     ${risks.map((r) => `<tr><td>${esc(r.case_ref)}</td><td>${esc(r.risk_reason_code)}</td><td>${esc(r.action)}</td><td>${esc(r.expires_at ?? "never")}</td>
       <td><form method="post" action="/trust/risk/${esc(r.id)}"><button class="secondary">Clear</button></form></td></tr>`).join("")}</table></div>`,
  );
}

async function ops(env: Env, staff: Staff, message?: string) {
  need(staff, "sysadmin");
  const summary = await env.GROUP_OPS.summary();
  return page(
    staff,
    "Operations",
    `${message ? `<div class="warn"><pre>${esc(message)}</pre></div>` : ""}
     <div class="row"><form method="post" action="/ops/publish"><button>Publish group epoch now</button></form>
     <form method="post" action="/ops/tick"><button>Run screening, maturation &amp; rankings</button></form>
     <form method="post" action="/ops/trust"><button>Run enrollment trust screening</button></form>
     <form method="post" action="/ops/rebuild"><button class="secondary">Rebuild all aggregates</button></form></div>
     <div class="card"><h2>Group roots</h2><pre>${esc(JSON.stringify(summary, null, 2))}</pre></div>`,
  );
}

async function auditPage(env: Env, staff: Staff) {
  const dir = await env.DIRECTORY.prepare(`SELECT * FROM directory_audit ORDER BY created_at DESC LIMIT 100`).all<Record<string, string>>();
  const mod = staff.roles.includes("moderator") || staff.roles.includes("sysadmin") ? ((await env.BALLOT_MOD.audit(100)) as Array<Record<string, string>>) : [];
  const ident = staff.roles.includes("moderator") || staff.roles.includes("sysadmin") ? ((await env.ACCOUNTS_ADMIN.audit()) as Array<Record<string, string>>) : [];
  const table = (rows: Array<Record<string, string>>, cols: string[]) =>
    `<div class="wrap"><table><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join("")}</tr>`).join("")}</table></div>`;
  return page(
    staff,
    "Audit trails",
    `<h2>Directory</h2>${table(dir.results, ["created_at", "action", "entity_id", "actor_role", "actor_ref", "change_summary"])}
     ${mod.length ? `<h2>Ballot moderation</h2>${table(mod, ["created_at", "case_id", "action", "from_status", "to_status", "actor_ref", "note"])}` : ""}
     ${ident.length ? `<h2>Enrollment trust</h2>${table(ident, ["created_at", "action", "actor_role", "actor_ref", "case_ref"])}` : ""}`,
  );
}

/* ------------------------------------------------------------------ */

async function route(request: Request, env: Env, staff: Staff): Promise<Response> {
  const url = new URL(request.url);
  const p = url.pathname;
  if (request.method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin !== env.ADMIN_ORIGIN) return new Response("Cross-origin form rejected", { status: 403 });
    const form = await request.formData();
    if (p === "/__dev/roles" && staff.dev) {
      const roles = form.getAll("role").map(String).filter((r) => (ROLES as string[]).includes(r));
      return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": `gz_admin_roles=${encodeURIComponent(roles.join(","))}; Path=/; HttpOnly; SameSite=Strict` } });
    }
    let m;
    if ((m = p.match(/^\/directory\/suggestions\/([0-9a-f-]{36})$/))) return resolveSuggestion(env, staff, m[1], form);
    if ((m = p.match(/^\/directory\/corrections\/([0-9a-f-]{36})$/))) return resolveCorrection(env, staff, m[1], form);
    if ((m = p.match(/^\/directory\/entities\/([0-9a-f-]{36})$/))) return updateEntity(env, staff, m[1], form);
    if ((m = p.match(/^\/moderation\/cases\/([A-Z0-9-]{4,20})$/))) {
      need(staff, "moderator");
      const decision = form.get("decision") === "EXCLUDE" ? "EXCLUDE" : "CLEAR";
      await env.BALLOT_MOD.resolve(m[1], decision, String(form.get("note") ?? ""), { role: "moderator", ref: staff.ref });
      return redirect("/moderation/cases");
    }
    if ((m = p.match(/^\/moderation\/entity\/([0-9a-f-]{36})\/quarantine$/))) {
      need(staff, "moderator");
      const ids = form.getAll("ballot").map(String).filter((v) => /^[0-9a-f-]{36}$/.test(v));
      const reasons = form.getAll("reason").map(String) as never[];
      if (ids.length) await env.BALLOT_MOD.quarantine(ids, reasons.length ? reasons : (["STAFF_REVIEW"] as never[]), { role: "moderator", ref: staff.ref });
      return redirect("/moderation/cases");
    }
    if ((m = p.match(/^\/trust\/resets\/([0-9a-f-]{36})$/))) {
      need(staff, "moderator");
      await env.ACCOUNTS_ADMIN.resolveResetRequest(m[1], form.get("approve") === "1", { role: "moderator", ref: staff.ref });
      return redirect("/trust");
    }
    if ((m = p.match(/^\/trust\/risk\/([0-9a-f-]{36})$/))) {
      need(staff, "moderator");
      await env.ACCOUNTS_ADMIN.clearRiskAction(m[1], { role: "moderator", ref: staff.ref });
      return redirect("/trust");
    }
    if (p === "/ops/publish") return need(staff, "sysadmin"), ops(env, staff, JSON.stringify(await env.GROUP_OPS.publishNow(), null, 2));
    if (p === "/ops/tick") return need(staff, "sysadmin"), ops(env, staff, JSON.stringify(await env.AGGREGATOR.tick(true), null, 2));
    if (p === "/ops/trust") return need(staff, "sysadmin"), ops(env, staff, JSON.stringify(await env.ACCOUNTS_ADMIN.runTrustScreening(), null, 2));
    if (p === "/ops/rebuild") return need(staff, "sysadmin"), ops(env, staff, JSON.stringify(await env.AGGREGATOR.rebuildAll(), null, 2));
    return page(staff, "Not found", "", 404);
  }
  if (p === "/") return dashboard(env, staff);
  if (p === "/directory/suggestions") return suggestions(env, staff);
  if (p === "/directory/corrections") return corrections(env, staff);
  if (p === "/directory/entities") return entities(env, staff, url);
  let m;
  if ((m = p.match(/^\/directory\/entities\/([0-9a-f-]{36})$/))) return entityEditor(env, staff, m[1], url.searchParams.has("saved"));
  if (p === "/moderation/cases") return cases(env, staff, url);
  if ((m = p.match(/^\/moderation\/entity\/([0-9a-f-]{36})$/))) return entityBallots(env, staff, m[1]);
  if (p === "/trust") return trust(env, staff);
  if (p === "/ops") return ops(env, staff);
  if (p === "/audit") return auditPage(env, staff);
  return page(staff, "Not found", "", 404);
}

export default {
  async fetch(request, env) {
    const staff = await authenticate(request, env);
    if (!staff) {
      return new Response("Forbidden: GovZones administration requires Cloudflare Access with an assigned role.", {
        status: 403,
        headers: { "Content-Type": "text/plain", "X-Robots-Tag": "noindex", "Cache-Control": "no-store" },
      });
    }
    try {
      return await route(request, env, staff);
    } catch (err) {
      if (err instanceof Forbidden) return page(staff, "Forbidden", "<p>Your role does not allow this action.</p>", 403);
      console.error("admin_error", err instanceof Error ? err.message : "unknown");
      return page(staff, "Error", "<p>Something went wrong.</p>", 500);
    }
  },
} satisfies ExportedHandler<Env>;
