import { useEffect, useId, useRef, useState } from "react";
import { Form, useNavigate } from "react-router";
import { ENTITY_TYPE_LABEL, entityPath, type EntityType } from "../../shared/directory";

interface Suggestion {
  id: string;
  name: string;
  acronym: string | null;
  type: EntityType;
  slug: string;
  place: string;
}

/**
 * Accessible combobox (ARIA 1.2 pattern). Works as a plain GET form without JavaScript;
 * with JavaScript it shows debounced instant suggestions (250 ms).
 * `variant="hero"` is the large box on the dark homepage band.
 */
export function SearchBox({
  defaultValue = "",
  country = "ph",
  autoFocus = false,
  label = "Search a government agency or office",
  variant = "default",
}: {
  defaultValue?: string;
  country?: string;
  autoFocus?: boolean;
  label?: string;
  variant?: "default" | "hero";
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [q, setQ] = useState(defaultValue);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const navigate = useNavigate();
  const abortRef = useRef<AbortController | null>(null);
  const hero = variant === "hero";

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setItems([]);
      return;
    }
    const t = window.setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch(`/api/v1/entities?country=${country.toUpperCase()}&limit=6&q=${encodeURIComponent(term)}`, { signal: ac.signal });
        const body = (await res.json()) as { items: Suggestion[] };
        setItems(body.items ?? []);
        setActive(-1);
        setOpen(true);
      } catch {
        /* aborted or offline: keep plain form behaviour */
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, country]);

  const choose = (s: Suggestion) => {
    setOpen(false);
    navigate(entityPath(country, s.type, s.slug));
  };

  return (
    <Form method="get" action={`/${country}/search`} role="search" className="relative w-full min-w-0" onSubmit={() => setOpen(false)}>
      <label htmlFor={`${id}-input`} className={hero ? "sr-only" : "label"}>
        {label}
      </label>
      <div className={`flex min-w-0 gap-2 ${hero ? "rounded-2xl bg-paper p-1.5 shadow-[var(--shadow-lift)]" : ""}`}>
        <div className="relative min-w-0 flex-1">
          {hero && (
            <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          )}
          <input
            id={`${id}-input`}
            name="q"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoFocus={autoFocus}
            className={hero ? "field min-h-12 border-0 pl-10 text-base shadow-none focus:ring-0 sm:text-lg" : "field"}
            placeholder={hero ? "Try “LTO”, “DFA Cebu” or “Pasig city hall”" : "e.g. LTO, DFA Cebu, city hall Pasig"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            role="combobox"
            aria-expanded={open && items.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            onKeyDown={(e) => {
              if (!open || items.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => (a + 1) % items.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
              } else if (e.key === "Enter" && active >= 0) {
                e.preventDefault();
                choose(items[active]);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onFocus={() => items.length && setOpen(true)}
          />
        </div>
        <button type="submit" className={`btn-primary shrink-0 ${hero ? "min-h-12 px-5" : ""}`}>
          Search
        </button>
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label="Suggestions"
        hidden={!open || items.length === 0}
        className="absolute left-0 right-0 z-30 mt-1 max-h-80 overflow-y-auto rounded-2xl border border-line bg-paper py-1 text-ink shadow-[var(--shadow-lift)]"
      >
        {items.map((s, i) => (
          <li
            key={s.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className={`cursor-pointer px-3 py-2 ${i === active ? "bg-accent-soft" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              choose(s);
            }}
          >
            <span className="block font-semibold">
              {s.name}
              {s.acronym ? <span className="font-normal text-muted"> ({s.acronym})</span> : null}
            </span>
            <span className="block text-sm text-muted">
              {ENTITY_TYPE_LABEL[s.type]} · {s.place}
            </span>
          </li>
        ))}
      </ul>
      <p className="sr-only" aria-live="polite">
        {open && items.length ? `${items.length} suggestions available` : ""}
      </p>
    </Form>
  );
}
