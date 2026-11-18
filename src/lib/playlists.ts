// Playlist endpoints, using the post-Feb-2026 paths (/me/playlists, /playlists/{id}/items).

import { api, type ApiResult } from "./spotify";
import { pickImage, type ApiImage } from "./library";
import { idbGet, idbSet } from "./cache";

const ADD_BATCH = 100; // per-request limit for adding items

export type PlaylistSummary = {
  id: string;
  name: string;
  url: string;
  image: string | null;
  total: number | null;
  isPublic: boolean | null;
  snapshot: string | null; // changes whenever the playlist changes
};

type ApiPlaylist = {
  id: string;
  name: string;
  public: boolean | null;
  collaborative: boolean;
  snapshot_id?: string;
  owner: { id: string };
  external_urls: { spotify: string };
  images: ApiImage[] | null;
  items?: { total: number }; // new name
  tracks?: { total: number }; // old name, just in case
};

function apiError(label: string, r: ApiResult): Error {
  return new Error(`${label} failed (${r.status}): ${typeof r.data === "string" ? r.data : JSON.stringify(r.data)}`);
}

function toSummary(p: ApiPlaylist): PlaylistSummary {
  return {
    id: p.id,
    name: p.name,
    url: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${p.id}`,
    image: pickImage(p.images),
    total: p.items?.total ?? p.tracks?.total ?? null,
    isPublic: p.public,
    snapshot: p.snapshot_id ?? null,
  };
}

/** Playlists the user can add to: ones they own, plus collaborative ones. */
export async function listEditablePlaylists(userId: string): Promise<PlaylistSummary[]> {
  const out: PlaylistSummary[] = [];
  let url: string | null = "/me/playlists?limit=50";
  while (url) {
    const r: ApiResult<{ items: (ApiPlaylist | null)[]; next: string | null }> = await api(url);
    if (!r.ok) throw apiError("GET /me/playlists", r);
    for (const p of r.data.items) {
      if (p && (p.owner?.id === userId || p.collaborative)) out.push(toSummary(p));
    }
    url = r.data.next;
  }
  return out;
}

/**
 * Creates a public playlist. (Spotify currently ignores `public: false` on create and on
 * PUT /playlists/{id} — verified 2026-11 — so users make playlists private in Spotify itself.)
 */
export async function createPlaylist(name: string, description: string): Promise<PlaylistSummary> {
  const r = await api<ApiPlaylist>("/me/playlists", {
    method: "POST",
    body: JSON.stringify({ name, description, public: true }),
  });
  if (!r.ok) throw apiError("POST /me/playlists", r);
  return toSummary(r.data);
}

/** All item URIs currently in a playlist (used to skip duplicates). */
export async function getPlaylistUris(playlistId: string): Promise<Set<string>> {
  const uris = new Set<string>();
  let url: string | null = `/playlists/${playlistId}/items?limit=100`;
  while (url) {
    type Entry = { item?: { uri?: string } | null; track?: { uri?: string } | null };
    const r: ApiResult<{ items: Entry[]; next: string | null }> = await api(url);
    if (!r.ok) throw apiError("GET /playlists/{id}/items", r);
    for (const e of r.data.items) {
      const uri = (e.item ?? e.track)?.uri; // the item field was renamed from "track" in 2026
      if (uri) uris.add(uri);
    }
    url = r.data.next;
  }
  return uris;
}

/** Appends URIs in order, in batches. Reports progress after each batch. */
export async function addItems(playlistId: string, uris: string[], onProgress: (added: number) => void): Promise<void> {
  for (let i = 0; i < uris.length; i += ADD_BATCH) {
    const batch = uris.slice(i, i + ADD_BATCH);
    const r = await api(`/playlists/${playlistId}/items`, {
      method: "POST",
      body: JSON.stringify({ uris: batch }),
    });
    if (!r.ok) throw apiError(`Adding songs ${i + 1}–${i + batch.length}`, r);
    onProgress(i + batch.length);
  }
}

/** Adds URIs that aren't already in the playlist, keeping order. */
export async function addSkippingDuplicates(
  playlistId: string,
  uris: string[],
  onProgress: (added: number, total: number) => void,
): Promise<{ added: number; skipped: number }> {
  const existing = await getPlaylistUris(playlistId);
  const toAdd = uris.filter((u) => !existing.has(u));
  onProgress(0, toAdd.length);
  await addItems(playlistId, toAdd, (n) => onProgress(n, toAdd.length));
  return { added: toAdd.length, skipped: uris.length - toAdd.length };
}

// ---------- Cache (so the side panel shows instantly) ----------

export async function loadPlaylistCache(userId: string): Promise<PlaylistSummary[] | null> {
  try {
    return (await idbGet<PlaylistSummary[]>(`playlists:${userId}`)) ?? null;
  } catch {
    return null;
  }
}

export async function savePlaylistCache(userId: string, list: PlaylistSummary[]): Promise<void> {
  try {
    await idbSet(`playlists:${userId}`, list);
  } catch {
    /* best-effort */
  }
}

// ---------- "Recently updated" ----------
// Spotify exposes no last-modified date, so we use when the last song (by position) was added.
// Cached per playlist by snapshot_id, so only changed playlists are re-checked.

export type UpdatedCache = Record<string, { snapshot: string | null; ts: number }>;

export async function loadUpdatedCache(userId: string): Promise<UpdatedCache> {
  try {
    return (await idbGet<UpdatedCache>(`pl_updated:${userId}`)) ?? {};
  } catch {
    return {};
  }
}

export async function saveUpdatedCache(userId: string, c: UpdatedCache): Promise<void> {
  try {
    await idbSet(`pl_updated:${userId}`, c);
  } catch {
    /* best-effort */
  }
}

export async function refreshUpdated(
  playlists: PlaylistSummary[],
  cache: UpdatedCache,
  onProgress: (done: number, total: number) => void,
): Promise<UpdatedCache> {
  const next: UpdatedCache = {};
  const stale: PlaylistSummary[] = [];
  for (const p of playlists) {
    const c = cache[p.id];
    if (c && p.snapshot && c.snapshot === p.snapshot) next[p.id] = c;
    else if (!p.total) next[p.id] = { snapshot: p.snapshot, ts: 0 };
    else stale.push(p);
  }

  let done = 0;
  let i = 0;
  onProgress(0, stale.length);
  const worker = async () => {
    while (i < stale.length) {
      const p = stale[i++];
      const r = await api<{ items: { added_at?: string | null }[] }>(
        `/playlists/${p.id}/items?limit=1&offset=${Math.max(0, (p.total ?? 1) - 1)}`,
      );
      const addedAt = r.ok ? r.data.items?.[0]?.added_at : null;
      next[p.id] = { snapshot: p.snapshot, ts: addedAt ? Date.parse(addedAt) || 0 : 0 };
      onProgress(++done, stale.length);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return next;
}
