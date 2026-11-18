// Client-side search + sort over the library.

import type { Track } from "./library";

export type SortKey = "added" | "released" | "title" | "artist" | "album" | "duration";
export type SortDir = "asc" | "desc";
export type SortLevel = { key: SortKey; dir: SortDir };
/** Primary sort plus an optional user-chosen secondary ("then by"). */
export type SortState = SortLevel & { then: SortLevel | null };

export const SORT_KEYS: SortKey[] = ["title", "artist", "album", "released", "added", "duration"];
export const SORT_LABELS: Record<SortKey, string> = {
  title: "Title",
  artist: "Artist",
  album: "Album",
  released: "Released",
  added: "Added",
  duration: "Time",
};

export const DEFAULT_SORT: SortState = { key: "added", dir: "desc", then: null };

/** Direction used when switching to a column for the first time. */
export const DEFAULT_DIR: Record<SortKey, SortDir> = {
  added: "desc",
  released: "desc",
  title: "asc",
  artist: "asc",
  album: "asc",
  duration: "asc",
};

const flip = (d: SortDir): SortDir => (d === "asc" ? "desc" : "asc");

/**
 * Header click. Plain click: set/flip the primary sort.
 * Shift+click: cycle the secondary sort on that column: default dir -> opposite -> off.
 */
export function nextSort(sort: SortState, key: SortKey, shift: boolean): SortState {
  if (shift) {
    if (key === sort.key) return sort; // can't be both primary and secondary
    if (sort.then?.key !== key) return { ...sort, then: { key, dir: DEFAULT_DIR[key] } };
    if (sort.then.dir === DEFAULT_DIR[key]) return { ...sort, then: { key, dir: flip(sort.then.dir) } };
    return { ...sort, then: null };
  }
  if (key === sort.key) return { ...sort, dir: flip(sort.dir) };
  return { key, dir: DEFAULT_DIR[key], then: sort.then?.key === key ? null : sort.then };
}

export function sanitizeSort(raw: unknown): SortState {
  const s = raw as Partial<SortState> | null;
  if (!s || !SORT_KEYS.includes(s.key as SortKey)) return DEFAULT_SORT;
  const dir = s.dir === "asc" ? "asc" : "desc";
  const then =
    s.then && SORT_KEYS.includes(s.then.key) && s.then.key !== s.key
      ? { key: s.then.key, dir: s.then.dir === "asc" ? "asc" : ("desc" as SortDir) }
      : null;
  return { key: s.key as SortKey, dir, then };
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function haystack(t: Track): string {
  return normalize(`${t.name} ${t.artists.join(" ")} ${t.album}`);
}

type Cmp = (a: Track, b: Track) => number;

const byAlbumOrder: Cmp = (a, b) =>
  collator.compare(a.album, b.album) || a.discNumber - b.discNumber || a.trackNumber - b.trackNumber;

// primary flips with direction; the built-in secondary is always ascending (keeps albums in track order).
const COMPARATORS: Record<SortKey, { primary: Cmp; secondary?: Cmp }> = {
  added: { primary: (a, b) => a.addedSort - b.addedSort },
  released: { primary: (a, b) => a.releaseSort - b.releaseSort, secondary: byAlbumOrder },
  title: {
    primary: (a, b) => collator.compare(a.name, b.name),
    secondary: (a, b) => collator.compare(a.artists[0] ?? "", b.artists[0] ?? ""),
  },
  artist: {
    primary: (a, b) => collator.compare(a.artists[0] ?? "", b.artists[0] ?? ""),
    secondary: (a, b) => a.releaseSort - b.releaseSort || byAlbumOrder(a, b),
  },
  album: {
    primary: (a, b) => collator.compare(a.album, b.album),
    secondary: (a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber,
  },
  duration: { primary: (a, b) => a.durationMs - b.durationMs },
};

export function buildView(tracks: Track[], haystacks: string[], query: string, sort: SortState): Track[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const out = terms.length ? tracks.filter((_, i) => terms.every((q) => haystacks[i].includes(q))) : tracks.slice();

  const primary = COMPARATORS[sort.key].primary;
  const m = sort.dir === "asc" ? 1 : -1;
  const then = sort.then ? COMPARATORS[sort.then.key].primary : null;
  const m2 = sort.then?.dir === "asc" ? 1 : -1;
  const builtIn = COMPARATORS[sort.key].secondary;

  out.sort(
    (a, b) =>
      m * primary(a, b) ||
      (then ? m2 * then(a, b) : 0) ||
      (builtIn ? builtIn(a, b) : 0) ||
      b.addedSort - a.addedSort,
  );
  return out;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
