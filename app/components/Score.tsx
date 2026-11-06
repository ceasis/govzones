import { formatScore, SCORING, type HistogramCell } from "../../shared/scoring";

/** "7.8 / 10" with a text alternative; never colour alone. */
export function ScoreValue({ mean, size = "md" }: { mean: number | null; size?: "sm" | "md" | "lg" | "xl" }) {
  const num = { sm: "text-lg font-bold", md: "text-2xl font-extrabold", lg: "text-5xl font-extrabold", xl: "text-6xl font-extrabold" }[size];
  const den = { sm: "text-xs", md: "text-sm", lg: "text-xl", xl: "text-2xl" }[size];
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap tracking-tight" aria-label={mean === null ? "No score" : `${formatScore(mean)} out of 10`}>
      <span className={`${num} tabular-nums`}>{formatScore(mean)}</span>
      <span className={`${den} font-semibold text-muted`}>/ 10</span>
    </span>
  );
}

/** Ten-cell bar filled to the score. Decorative: the number is always printed beside it. */
export function ScaleBar({ mean, className = "" }: { mean: number | null; className?: string }) {
  const on = mean === null ? 0 : Math.round(mean);
  return (
    <span className={`scale-bar ${className}`} aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} data-on={i < on ? "" : undefined} />
      ))}
    </span>
  );
}

export function ScoreSummary({ count, mean, displayable, align = "right" }: { count: number; mean: number | null; displayable: boolean; align?: "right" | "left" }) {
  const side = align === "right" ? "items-end text-right" : "items-start text-left";
  if (!displayable) {
    return (
      <div className={`flex flex-col ${side} text-sm`}>
        <p className="font-semibold text-muted">{count === 0 ? "No ratings yet" : "Not enough ratings"}</p>
        <p className="text-xs text-muted">
          {SCORING.profileMinDisplay <= 1 ? "a score appears from the first counted rating" : `${count === 0 ? "none yet" : `${count} so far`} · a score appears from ${SCORING.profileMinDisplay}`}
        </p>
      </div>
    );
  }
  return (
    <div className={`flex flex-col ${side}`}>
      <ScoreValue mean={mean} />
      <ScaleBar mean={mean} className="mt-1" />
      <p className="mt-1 text-xs text-muted">
        {count.toLocaleString("en")} rating{count === 1 ? "" : "s"}
      </p>
    </div>
  );
}

export function Histogram({ cells, total }: { cells: HistogramCell[] | null; total: number }) {
  if (!cells) {
    return (
      <p className="rounded-xl bg-sunken p-3 text-sm text-muted">
        {SCORING.histogramMinTotal <= 1
          ? "The breakdown of ratings appears as soon as the first rating is counted."
          : `The breakdown of ratings appears once there are at least ${SCORING.histogramMinTotal} ratings, to protect anonymity.`}
      </p>
    );
  }
  const max = Math.max(1, ...cells.map((c) => c.count ?? SCORING.histogramMinBucket));
  return (
    <figure>
      <figcaption className="mb-2 flex items-baseline justify-between gap-2 text-sm">
        <span className="font-semibold">How people rated</span>
        <span className="text-muted">
          {total.toLocaleString("en")} rating{total === 1 ? "" : "s"}
        </span>
      </figcaption>
      <ol className="space-y-1.5" aria-label="Breakdown of ratings">
        {[...cells].reverse().map((c) => {
          const width = c.suppressed ? (SCORING.histogramMinBucket / max) * 100 : ((c.count ?? 0) / max) * 100;
          const label = c.suppressed ? `< ${SCORING.histogramMinBucket}` : String(c.count);
          const pct = !c.suppressed && total > 0 && c.count ? Math.round((c.count / total) * 100) : null;
          return (
            <li key={c.score} className="grid grid-cols-[1.5rem_1fr_4.5rem] items-center gap-2 text-sm">
              <span className="text-right font-bold tabular-nums">{c.score}</span>
              <span className="h-3.5 min-w-0 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
                <span
                  className={`block h-full rounded-full ${c.suppressed ? "bg-[repeating-linear-gradient(45deg,#94a3b8_0,#94a3b8_3px,#e2e8f0_3px,#e2e8f0_6px)]" : "bg-accent"}`}
                  style={{ width: `${Math.max(c.count || c.suppressed ? 2 : 0, width)}%` }}
                />
              </span>
              <span className="text-right text-xs tabular-nums text-muted">
                <span className="sr-only">Score {c.score}: </span>
                {label}
                {pct !== null && <span className="text-faint"> · {pct}%</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-xs text-muted">
        Whole numbers 1–10.{SCORING.histogramMinBucket > 1 ? ` “< ${SCORING.histogramMinBucket}” means fewer than ${SCORING.histogramMinBucket} people.` : ""}
      </p>
    </figure>
  );
}
