import { Link } from "react-router";
import { ENTITY_TYPE_LABEL, entityPath } from "../../shared/directory";
import type { EntitySummary } from "../lib/data.server";
import { ScoreSummary } from "./Score";

export function EntityCard({ entity, country = "ph" }: { entity: EntitySummary; country?: string }) {
  const s = entity.scores["12m"];
  return (
    <li className="card card-hover relative flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 basis-56">
        <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span className="badge border-line bg-sunken text-muted">{ENTITY_TYPE_LABEL[entity.type]}</span>
          {entity.verified && (
            <span className="badge border-ok-line/50 bg-ok-bg text-ok-line" title="Checked against official sources">
              ✓ Verified
            </span>
          )}
        </p>
        <h3 className="font-bold leading-snug">
          {/* The whole card is clickable (stretched link), while the accessible name stays on the heading. */}
          <Link className="link-plain after:absolute after:inset-0 after:rounded-[1rem] after:content-['']" to={entityPath(country, entity.type, entity.slug)}>
            {entity.name}
          </Link>
          {entity.acronym && <span className="ml-1 text-sm font-medium text-muted">({entity.acronym})</span>}
        </h3>
        <p className="mt-0.5 text-sm text-muted">{entity.place}</p>
      </div>
      <ScoreSummary count={s.count} mean={s.mean} displayable={s.displayable} />
    </li>
  );
}
