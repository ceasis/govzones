import { useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/suggest";
import { envFrom, requireCountry } from "../lib/route.server";
import { ENTITY_TYPES, ENTITY_TYPE_LABEL } from "../../shared/directory";
import { useConfig } from "../lib/config";
import { useWallet } from "../wallet/WalletContext";

export async function loader({ context, params }: Route.LoaderArgs) {
  const country = await requireCountry(context, params.country);
  const env = envFrom(context);
  const [agencies, geo] = await Promise.all([
    env.DIRECTORY.prepare(
      `SELECT id, name, acronym FROM entities WHERE country_code = ?1 AND status = 'ACTIVE' AND type IN ('AGENCY', 'OTHER_PUBLIC_BODY', 'LGU') ORDER BY name`,
    )
      .bind(country.code)
      .all<{ id: string; name: string; acronym: string | null }>(),
    env.DIRECTORY.prepare(
      `SELECT g.id, g.name, g.type, r.short_name AS region FROM geo_units g
         LEFT JOIN geo_units p ON p.id = g.parent_id
         LEFT JOIN geo_units r ON r.id = COALESCE(CASE WHEN p.type = 'REGION' THEN p.id END, p.parent_id)
        WHERE g.country_code = ?1 AND g.type IN ('PROVINCE', 'CITY', 'MUNICIPALITY') ORDER BY g.name`,
    )
      .bind(country.code)
      .all<{ id: string; name: string; type: string; region: string | null }>(),
  ]);
  return { agencies: agencies.results, geo: geo.results };
}

export const meta: Route.MetaFunction = () => [{ title: "Suggest a missing office · GovZones Philippines" }, { name: "robots", content: "noindex" }];

export default function Suggest({ loaderData }: Route.ComponentProps) {
  const cfg = useConfig();
  const { session } = useWallet();
  const [state, setState] = useState<{ k: "idle" | "sending" | "error" | "sent"; msg?: string }>({ k: "idle" });

  return (
    <div className="container-page max-w-2xl py-8">
      <h1 className="text-2xl font-bold">Suggest a missing office</h1>
      <p className="mt-2 text-muted">
        Curators check every suggestion against an official source (an agency or LGU website, a government directory) and look for duplicates before
        publishing. We do not store who suggested it.
      </p>
      {session === null ? (
        <p className="mt-4">Loading…</p>
      ) : !session.signedIn ? (
        <div className="card mt-6">
          <p>Suggestions require sign-in, to limit spam.</p>
          <Link to="/sign-in" className="btn-primary mt-3">
            Sign in
          </Link>
        </div>
      ) : state.k === "sent" ? (
        <p className="notice-ok mt-6">Thank you — your suggestion was received (reference {state.msg}). It will appear once a curator has verified it.</p>
      ) : (
        <form
          className="card mt-6 grid gap-3"
          onSubmit={async (ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            setState({ k: "sending" });
            try {
              const { accountsCall } = await import("../wallet/clients");
              const res = await accountsCall<{ reference: string }>(cfg, "/api/v1/entities/suggestions", "POST", {
                country: "PH",
                name: f.get("name"),
                type: f.get("type"),
                parentEntityId: f.get("parent") || undefined,
                geoUnitId: f.get("geo") || undefined,
                address: f.get("address") || undefined,
                sourceUrl: f.get("sourceUrl"),
                notes: f.get("notes") || undefined,
              });
              setState({ k: "sent", msg: res.reference });
            } catch (e) {
              setState({ k: "error", msg: e instanceof Error ? e.message : "Could not send." });
            }
          }}
        >
          <div>
            <label className="label" htmlFor="s-name">
              Official name of the office
            </label>
            <input id="s-name" name="name" className="field" required maxLength={200} placeholder="e.g. LTO Licensing Center – …" />
          </div>
          <div>
            <label className="label" htmlFor="s-type">
              Kind of office
            </label>
            <select id="s-type" name="type" className="field" required defaultValue="FIELD_OFFICE">
              {ENTITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ENTITY_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="s-parent">
              Parent agency or local government (if any)
            </label>
            <select id="s-parent" name="parent" className="field" defaultValue="">
              <option value="">None / not sure</option>
              {loaderData.agencies.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.acronym ? ` (${a.acronym})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="s-geo">
              City, municipality or province
            </label>
            <select id="s-geo" name="geo" className="field" defaultValue="">
              <option value="">Not sure</option>
              {loaderData.geo.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                  {g.type === "PROVINCE" ? " (province)" : ""}
                  {g.region ? ` — ${g.region}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="s-address">
              Address (optional)
            </label>
            <input id="s-address" name="address" className="field" maxLength={300} />
          </div>
          <div>
            <label className="label" htmlFor="s-src">
              Official source link (required)
            </label>
            <input id="s-src" name="sourceUrl" type="url" className="field" required placeholder="https://… (agency or LGU page listing this office)" />
          </div>
          <div>
            <label className="label" htmlFor="s-notes">
              Notes for the curator (optional, no personal information)
            </label>
            <textarea id="s-notes" name="notes" className="field min-h-24" maxLength={1000} />
          </div>
          {state.k === "error" && <p className="notice">{state.msg}</p>}
          <div>
            <button className="btn-primary" disabled={state.k === "sending"}>
              {state.k === "sending" ? "Sending…" : "Send suggestion"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
