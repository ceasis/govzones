import { Link } from "react-router";
import { ENTITY_TYPE_LABEL, entityPath, type EntityType } from "../../shared/directory";
import { SCORING, countedRatings } from "../../shared/scoring";
import { ScaleBar, ScoreValue } from "./Score";

export interface RankingRowView {
  entityId: string;
  rank: number;
  name: string;
  acronym: string | null;
  slug: string;
  type: EntityType;
  place: string;
  rawMean: number;
  count: number;
  qualified?: boolean;
}

function RankBadge({ rank }: { rank: number }) {
  const top = rank <= 3;
  return (
    <span
      className={`grid size-10 shrink-0 place-items-center rounded-full border-2 text-sm font-extrabold tabular-nums ${
        top ? "border-gold bg-gold-soft text-gold" : "border-line bg-sunken text-ink"
      }`}
      aria-label={`Rank ${rank}`}
    >
      {rank}
    </span>
  );
}

/** Stacked cards (no wide tables): rank, entity, geography, raw average, eligible count, period, methodology link. */
export function RankingList({
  rows,
  periodLabel,
  country = "ph",
  showQualification = false,
  startRank = 1,
}: {
  rows: RankingRowView[];
  periodLabel: string;
  country?: string;
  showQualification?: boolean;
  startRank?: number;
}) {
  return (
    <ol className="space-y-2" start={startRank}>
      {rows.map((r) => (
        <li key={r.entityId} className="card card-hover relative flex min-w-0 items-start gap-3">
          <RankBadge rank={r.rank} />
          <div className="min-w-0 flex-1">
            <h3 className="font-bold leading-snug">
              <Link to={entityPath(country, r.type, r.slug)} className="link-plain after:absolute after:inset-0 after:rounded-[1rem] after:content-['']">
                {r.name}
              </Link>
              {r.acronym && <span className="ml-1 text-sm font-medium text-muted">({r.acronym})</span>}
            </h3>
            <p className="text-sm text-muted">
              {ENTITY_TYPE_LABEL[r.type]} · {r.place}
            </p>
            <p className="mt-1 text-xs text-muted">
              {periodLabel}
              {showQualification && r.qualified === false
                ? ` · not yet ranked (needs ${countedRatings(SCORING.minRankingVotes)})`
                : ""}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end text-right">
            <ScoreValue mean={r.rawMean} />
            <ScaleBar mean={r.rawMean} className="mt-1" />
            <p className="mt-1 text-xs text-muted">
              {r.count.toLocaleString("en")} rating{r.count === 1 ? "" : "s"}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
