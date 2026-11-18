"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Track } from "@/lib/library";
import { formatDuration, SORT_KEYS, SORT_LABELS, type SortKey, type SortLevel, type SortState } from "@/lib/view";

const ROW_H = 56;
const HEADER_H = 36;
const LONG_PRESS_MS = 500;

// ---------- Columns ----------

export type ColKey = "artist" | "album" | "released" | "added" | "time";

const OPTIONAL_COLS: { key: ColKey; label: string; sort: SortKey; width: string }[] = [
  { key: "artist", label: "Artist", sort: "artist", width: "minmax(0, 2fr)" },
  { key: "album", label: "Album", sort: "album", width: "minmax(0, 2fr)" },
  { key: "released", label: "Released", sort: "released", width: "92px" },
  { key: "added", label: "Added", sort: "added", width: "92px" },
  { key: "time", label: "Time", sort: "duration", width: "48px" },
];

type Breakpoint = "wide" | "medium" | "narrow";
const DEFAULT_COLS: Record<Breakpoint, ColKey[]> = {
  wide: ["artist", "album", "released", "added", "time"],
  medium: ["album", "released", "time"],
  narrow: ["time"],
};
const COLS_STORAGE = "pm_columns";

function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>("wide");
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 600px)");
    const medium = window.matchMedia("(max-width: 900px)");
    const update = () => setBp(narrow.matches ? "narrow" : medium.matches ? "medium" : "wide");
    update();
    narrow.addEventListener("change", update);
    medium.addEventListener("change", update);
    return () => {
      narrow.removeEventListener("change", update);
      medium.removeEventListener("change", update);
    };
  }, []);
  return bp;
}

/** Visible columns, remembered separately per screen size. */
function useColumns(bp: Breakpoint) {
  const [prefs, setPrefs] = useState<Partial<Record<Breakpoint, ColKey[]>>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLS_STORAGE);
      if (raw) setPrefs(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const visible = prefs[bp] ?? DEFAULT_COLS[bp];
  const save = (next: Partial<Record<Breakpoint, ColKey[]>>) => {
    setPrefs(next);
    try {
      localStorage.setItem(COLS_STORAGE, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const toggle = (key: ColKey) => {
    const set = new Set(visible);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    save({ ...prefs, [bp]: OPTIONAL_COLS.map((c) => c.key).filter((k) => set.has(k)) });
  };
  const reset = () => {
    const { [bp]: _, ...rest } = prefs;
    save(rest);
  };
  return { visible, toggle, reset };
}

// ---------- Component ----------

type Props = {
  view: Track[];
  selected: Set<string>;
  sort: SortState;
  onSort: (key: SortKey, shift: boolean) => void;
  onSetThen: (then: SortLevel | null) => void;
  onRowClick: (index: number, e: React.MouseEvent) => void;
  resetScrollKey: string; // scroll to top when this changes (new search/sort)
};

export default function TrackList({ view, selected, sort, onSort, onSetThen, onRowClick, resetScrollKey }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bp = useBreakpoint();
  const { visible, toggle, reset } = useColumns(bp);
  const cols = OPTIONAL_COLS.filter((c) => visible.includes(c.key));
  const gridTemplateColumns = `28px 40px minmax(0, 3fr) ${cols.map((c) => c.width).join(" ")}`;
  const showArtist = visible.includes("artist");
  const showAlbum = visible.includes("album");

  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const virtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    scrollMargin: HEADER_H, // the sticky header sits above the rows inside the scroller
    getItemKey: (i) => view[i].uri,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetScrollKey]);

  // ----- Long-press / right-click on the header opens the column menu -----
  const press = useRef<{ timer: number | null; x: number; y: number; fired: boolean }>({ timer: null, x: 0, y: 0, fired: false });
  const cancelPress = () => {
    if (press.current.timer !== null) window.clearTimeout(press.current.timer);
    press.current.timer = null;
  };
  const headerHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      cancelPress();
      press.current = {
        x: e.clientX,
        y: e.clientY,
        fired: false,
        timer: window.setTimeout(() => {
          press.current.fired = true;
          setMenuOpen(true);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onPointerLeave: cancelPress,
    onClickCapture: (e: React.MouseEvent) => {
      // A long-press shouldn't also count as a sort click.
      if (press.current.fired) {
        e.stopPropagation();
        e.preventDefault();
        press.current.fired = false;
      }
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      cancelPress();
      setMenuOpen(true);
    },
  };

  const arrow = (key: SortKey) => {
    if (sort.key === key) return <span className="arrow">{sort.dir === "asc" ? "▲" : "▼"}</span>;
    if (sort.then?.key === key)
      return (
        <span className="arrow then" title="Secondary sort">
          {sort.then.dir === "asc" ? "▲▲" : "▼▼"}
        </span>
      );
    return null;
  };

  const sortButton = (key: SortKey, label: string, className: string) => (
    <button
      key={className}
      className={`col-sort ${className} ${sort.key === key || sort.then?.key === key ? "active" : ""}`}
      onClick={(e) => onSort(key, e.shiftKey)}
      title={`Sort by ${label.toLowerCase()} · Shift+click for secondary sort · long-press for columns`}
    >
      {label}
      {arrow(key)}
    </button>
  );

  return (
    <div className="list-wrap">
      <div className="list-scroll" ref={scrollRef} role="listbox" aria-multiselectable="true" aria-label="Liked songs">
        <div className="list-header grid" style={{ height: HEADER_H, gridTemplateColumns }} {...headerHandlers}>
          <span className="c-check">
            <button className="icon-btn" data-menu-toggle onClick={() => setMenuOpen((o) => !o)} title="Columns & sorting" aria-label="Columns and sorting">
              ⋮
            </button>
          </span>
          <span className="c-cover" />
          {sortButton("title", "Title", "c-title")}
          {cols.map((c) => sortButton(c.sort, c.label, `c-${c.key}`))}
        </div>

        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const t = view[vi.index];
            const isSel = selected.has(t.uri);
            const sub = [!showArtist && t.artists.join(", "), !showAlbum && t.album].filter(Boolean).join(" · ");
            return (
              <div
                key={vi.key}
                role="option"
                aria-selected={isSel}
                className={`row grid ${isSel ? "selected" : ""}`}
                style={{ height: ROW_H, gridTemplateColumns, transform: `translateY(${vi.start - HEADER_H}px)` }}
                onMouseDown={(e) => e.shiftKey && e.preventDefault() /* no text selection on shift-click */}
                onClick={(e) => onRowClick(vi.index, e)}
              >
                <span className="c-check">
                  <span className="check">{isSel ? "✓" : ""}</span>
                </span>
                <span className="c-cover">
                  {t.image ? <img src={t.image} alt="" width={40} height={40} loading="lazy" /> : <span className="cover-ph" />}
                </span>
                <span className="c-title">
                  <span className="title">
                    {t.name}
                    {t.explicit && <span className="badge">E</span>}
                  </span>
                  {sub && <span className="sub">{sub}</span>}
                </span>
                {cols.map((c) => (
                  <span key={c.key} className={`c-${c.key} ${c.key === "artist" || c.key === "album" ? "ellipsis" : "muted"}`}>
                    {c.key === "artist" && t.artists.join(", ")}
                    {c.key === "album" && t.album}
                    {c.key === "released" && (t.releaseDate || "—")}
                    {c.key === "added" && t.addedAt.slice(0, 10)}
                    {c.key === "time" && formatDuration(t.durationMs)}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {menuOpen && (
        <ColumnMenu
          visible={visible}
          onToggle={toggle}
          onReset={reset}
          sort={sort}
          onSetThen={onSetThen}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

// ---------- Column & sorting menu ----------

function ColumnMenu({
  visible,
  onToggle,
  onReset,
  sort,
  onSetThen,
  onClose,
}: {
  visible: ColKey[];
  onToggle: (k: ColKey) => void;
  onReset: () => void;
  sort: SortState;
  onSetThen: (then: SortLevel | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!ref.current?.contains(target) && !target.closest("[data-menu-toggle]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Defer so the pointerdown that opened the menu doesn't immediately close it.
    const id = window.setTimeout(() => document.addEventListener("pointerdown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="popover" ref={ref} data-popover role="dialog" aria-label="Columns and sorting">
      <div className="popover-title">Columns</div>
      <label className="check-line disabled">
        <input type="checkbox" checked disabled /> Title
      </label>
      {OPTIONAL_COLS.map((c) => (
        <label key={c.key} className="check-line">
          <input type="checkbox" checked={visible.includes(c.key)} onChange={() => onToggle(c.key)} /> {c.label}
        </label>
      ))}
      <button className="link-btn" onClick={onReset}>
        Reset columns for this screen size
      </button>

      <div className="popover-title">Then sort by</div>
      <div className="hstack">
        <select
          value={sort.then?.key ?? ""}
          onChange={(e) => {
            const key = e.target.value as SortKey | "";
            onSetThen(key ? { key, dir: sort.then?.dir ?? "asc" } : null);
          }}
        >
          <option value="">Default</option>
          {SORT_KEYS.filter((k) => k !== sort.key).map((k) => (
            <option key={k} value={k}>
              {SORT_LABELS[k]}
            </option>
          ))}
        </select>
        {sort.then && (
          <button
            className="secondary small"
            onClick={() => onSetThen({ ...sort.then!, dir: sort.then!.dir === "asc" ? "desc" : "asc" })}
          >
            {sort.then.dir === "asc" ? "▲ Asc" : "▼ Desc"}
          </button>
        )}
      </div>
      <p className="hint muted">Tip: Shift+click a column header to cycle its secondary sort (▲▲ → ▼▼ → off).</p>
    </div>
  );
}
