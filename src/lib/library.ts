// Liked-songs library: slim track model, full + incremental sync, and the IndexedDB cache.

import { api } from "./spotify";
import { idbGet, idbSet } from "./cache";

export type Track = {
  uri: string;
  id: string | null;
  name: string;
  artists: string[];
  album: string;
  albumId: string | null;
  image: string | null;
  releaseDate: string; // as returned: "1987" | "1987-05" | "1987-05-12" | ""
  releasePrecision: "year" | "month" | "day" | null;
  releaseSort: number; // normalized epoch ms (partial dates -> first of month/year)
  addedAt: string; // ISO timestamp
  addedSort: number;
  durationMs: number;
  discNumber: number;
  trackNumber: number;
  explicit: boolean;
  isLocal: boolean;
};

export type LibraryCache = {
  version: number;
  tracks: Track[]; // newest-added first, like the API
  total: number;
  syncedAt: number;
};

const CACHE_VERSION = 1; // bump if the Track shape changes
const PAGE = 50;
const CONCURRENCY = 4;

/** Used for dates Spotify doesn't give us (e.g. "0000"): sorts before everything. */
export const UNKNOWN_DATE = -8.64e15;

// ---------- Mapping from the raw API shape ----------

export type ApiImage = { url: string; width: number | null; height: number | null };
type ApiSavedTrack = {
  added_at: string;
  track: {
    id: string | null;
    uri: string;
    name: string;
    duration_ms: number;
    explicit: boolean;
    is_local: boolean;
    disc_number: number;
    track_number: number;
    artists: { name: string }[];
    album: {
      id: string | null;
      name: string;
      release_date: string | null;
      release_date_precision: "year" | "month" | "day" | null;
      images: ApiImage[];
    };
  } | null;
};
type ApiSavedPage = { items: ApiSavedTrack[]; total: number; next: string | null };

export function releaseToSort(date: string | null | undefined): number {
  if (!date) return UNKNOWN_DATE;
  const [y, m = "1", d = "1"] = date.split("-");
  const year = Number(y);
  if (!Number.isFinite(year) || year < 1000) return UNKNOWN_DATE; // Date.UTC maps 0-99 to 1900s
  const t = Date.UTC(year, Number(m) - 1, Number(d));
  return Number.isNaN(t) ? UNKNOWN_DATE : t;
}

/**
 * Songs Spotify no longer serves come back with an empty name/artists/album and a "0000" date.
 * They stay in the cache (so counts match Spotify's total) but are hidden from the list.
 */
export function isUnavailable(t: Track): boolean {
  return !t.name.trim();
}

export function pickImage(images: ApiImage[] | null | undefined): string | null {
  if (!images?.length) return null;
  // Smallest image that's still sharp at 40px on a 2x screen; images come largest-first.
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= 80) ?? sorted[sorted.length - 1]).url;
}

function toTrack(item: ApiSavedTrack): Track | null {
  const t = item.track;
  if (!t) return null;
  return {
    uri: t.uri,
    id: t.id,
    name: t.name,
    artists: t.artists.map((a) => a.name),
    album: t.album.name,
    albumId: t.album.id,
    image: pickImage(t.album.images),
    releaseDate: t.album.release_date ?? "",
    releasePrecision: t.album.release_date_precision ?? null,
    releaseSort: releaseToSort(t.album.release_date),
    addedAt: item.added_at,
    addedSort: Date.parse(item.added_at) || 0,
    durationMs: t.duration_ms,
    discNumber: t.disc_number,
    trackNumber: t.track_number,
    explicit: t.explicit,
    isLocal: t.is_local,
  };
}

async function fetchPage(offset: number): Promise<{ tracks: Track[]; total: number }> {
  const res = await api<ApiSavedPage>(`/me/tracks?limit=${PAGE}&offset=${offset}`);
  if (!res.ok) throw new Error(`GET /me/tracks failed (${res.status}): ${JSON.stringify(res.data)}`);
  return {
    tracks: res.data.items.map(toTrack).filter((t): t is Track => t !== null),
    total: res.data.total,
  };
}

function dedupe(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((t) => (seen.has(t.uri) ? false : (seen.add(t.uri), true)));
}

// ---------- Cache ----------

const cacheKey = (userId: string) => `liked:${userId}`;

export async function loadCache(userId: string): Promise<LibraryCache | null> {
  try {
    const c = await idbGet<LibraryCache>(cacheKey(userId));
    return c && c.version === CACHE_VERSION ? c : null;
  } catch {
    return null;
  }
}

async function saveCache(userId: string, tracks: Track[], total: number): Promise<LibraryCache> {
  const entry: LibraryCache = { version: CACHE_VERSION, tracks, total, syncedAt: Date.now() };
  try {
    await idbSet(cacheKey(userId), entry);
  } catch {
    /* cache is best-effort */
  }
  return entry;
}

// ---------- Sync ----------

export type SyncProgress = { loaded: number; total: number; mode: "incremental" | "full" };
export type SyncResult = { cache: LibraryCache; added: number; mode: "incremental" | "full" };

/**
 * Brings the library up to date. With a cache, fetches only pages until it reaches a
 * song it already knows (the API is newest-added first). If the resulting count doesn't
 * match Spotify's total (songs were unliked), falls back to a full reload.
 */
export async function syncLibrary(
  userId: string,
  cached: LibraryCache | null,
  onProgress: (p: SyncProgress) => void,
): Promise<SyncResult> {
  const first = await fetchPage(0);

  if (cached?.tracks.length) {
    const key = (t: Track) => `${t.uri}|${t.addedAt}`;
    const known = new Set(cached.tracks.map(key));
    const fresh: Track[] = [];
    let page = first;
    let offset = 0;
    let reachedKnown = false;

    while (true) {
      for (const t of page.tracks) {
        if (known.has(key(t))) {
          reachedKnown = true;
          break;
        }
        fresh.push(t);
      }
      onProgress({ loaded: fresh.length, total: first.total - cached.tracks.length, mode: "incremental" });
      if (reachedKnown) break;
      offset += PAGE;
      if (offset >= page.total) break;
      page = await fetchPage(offset);
    }

    const merged = dedupe([...fresh, ...cached.tracks]);
    if (merged.length === first.total) {
      return { cache: await saveCache(userId, merged, first.total), added: fresh.length, mode: "incremental" };
    }
    // Counts disagree (something was unliked, or the cache is stale): reload everything.
  }

  const total = first.total;
  const pages: Track[][] = [first.tracks];
  let loaded = first.tracks.length;
  onProgress({ loaded, total, mode: "full" });

  const offsets: number[] = [];
  for (let o = PAGE; o < total; o += PAGE) offsets.push(o);

  // Fetch remaining pages with limited concurrency, keeping them in order.
  let next = 0;
  async function worker() {
    while (next < offsets.length) {
      const i = next++;
      const { tracks } = await fetchPage(offsets[i]);
      pages[i + 1] = tracks;
      loaded += tracks.length;
      onProgress({ loaded, total, mode: "full" });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const tracks = dedupe(pages.flat());
  const added = cached ? Math.max(0, tracks.length - cached.tracks.length) : tracks.length;
  return { cache: await saveCache(userId, tracks, total), added, mode: "full" };
}
