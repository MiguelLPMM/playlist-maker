"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/spotify";
import { isUnavailable, loadCache, pickImage, syncLibrary, type LibraryCache, type SyncProgress, type Track } from "@/lib/library";
import { buildView, DEFAULT_SORT, haystack, nextSort, sanitizeSort, type SortKey, type SortLevel, type SortState } from "@/lib/view";
import {
  addSkippingDuplicates,
  listEditablePlaylists,
  loadPlaylistCache,
  loadUpdatedCache,
  refreshUpdated,
  savePlaylistCache,
  saveUpdatedCache,
  type PlaylistSummary,
  type UpdatedCache,
} from "@/lib/playlists";
import Icon from "./Icon";
import TrackList from "./TrackList";
import AddToPlaylistDialog from "./AddToPlaylistDialog";
import Sidebar from "./Sidebar";

type SyncState =
  | { status: "idle" }
  | { status: "syncing"; progress: SyncProgress | null }
  | { status: "done"; message: string }
  | { status: "error"; message: string };

type QuickAdd =
  | null
  | { kind: "working"; text: string; added: number; total: number }
  | {
      kind: "done";
      results: { name: string; url: string; added: number; skipped: number }[];
      errors: string[];
      skippedLocal: number;
    };

const SORT_STORAGE = "pm_sort";
const SIDEBAR_STORAGE = "pm_sidebar_open";
const targetsKey = (userId: string) => `pm_targets:${userId}`;

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function formatSynced(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? `today at ${time}` : `${d.toLocaleDateString()} ${time}`;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Library({ onLogout }: { onLogout: () => void }) {
  const [user, setUser] = useState<{ id: string; name: string; image: string | null } | null>(null);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [cache, setCache] = useState<LibraryCache | null>(null);
  const [sync, setSync] = useState<SyncState>({ status: "idle" });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null); // uri of the last plain click, for shift-range
  const [dialogOpen, setDialogOpen] = useState(false);

  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [playlistsError, setPlaylistsError] = useState<string | null>(null);
  const [targets, setTargetsState] = useState<Set<string>>(() => new Set()); // playlist ids
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [quick, setQuick] = useState<QuickAdd>(null);
  const [updated, setUpdated] = useState<UpdatedCache | null>(null);
  const [updatedProgress, setUpdatedProgress] = useState<{ done: number; total: number } | null>(null);
  const [animate, setAnimate] = useState(false); // no slide animation on first paint
  const updatingRef = useRef(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const started = useRef(false);
  const userRef = useRef<string | null>(null);

  useEffect(() => {
    const raw = readLocal(SORT_STORAGE);
    if (raw) {
      try {
        setSort(sanitizeSort(JSON.parse(raw)));
      } catch {
        /* ignore */
      }
    }
    const sb = readLocal(SIDEBAR_STORAGE);
    setSidebarOpen(sb !== null ? sb === "1" : window.matchMedia("(min-width: 901px)").matches);
    const id = window.setTimeout(() => setAnimate(true), 50);
    return () => window.clearTimeout(id);
  }, []);

  const toggleSidebar = (open: boolean) => {
    setSidebarOpen(open);
    writeLocal(SIDEBAR_STORAGE, open ? "1" : "0");
  };

  // Target playlists are remembered per user.
  const setTargets = useCallback((update: (prev: Set<string>) => Set<string>) => {
    setTargetsState((prev) => {
      const next = update(prev);
      if (userRef.current) writeLocal(targetsKey(userRef.current), JSON.stringify([...next]));
      return next;
    });
  }, []);

  // ---------- Loading / syncing ----------

  const runSync = useCallback(async (userId: string, from: LibraryCache | null) => {
    setSync({ status: "syncing", progress: null });
    try {
      const result = await syncLibrary(userId, from, (progress) => setSync({ status: "syncing", progress }));
      setCache(result.cache);
      setTracks(result.cache.tracks);
      const message =
        result.mode === "full"
          ? `Loaded ${result.cache.tracks.length.toLocaleString()} songs`
          : result.added
            ? `${result.added} new song${result.added === 1 ? "" : "s"}`
            : "Up to date";
      setSync({ status: "done", message });
    } catch (e) {
      setSync({ status: "error", message: errMsg(e) });
    }
  }, []);

  const refreshPlaylists = useCallback(
    async (userId: string) => {
      setPlaylistsLoading(true);
      setPlaylistsError(null);
      try {
        const list = await listEditablePlaylists(userId);
        setPlaylists(list);
        await savePlaylistCache(userId, list);
        const ids = new Set(list.map((p) => p.id));
        setTargets((prev) => new Set([...prev].filter((id) => ids.has(id)))); // drop deleted playlists
      } catch (e) {
        setPlaylistsError(errMsg(e));
      } finally {
        setPlaylistsLoading(false);
      }
    },
    [setTargets],
  );

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in dev
    started.current = true;
    (async () => {
      const me = await api<{ id: string; display_name: string | null; images?: { url: string; width: number | null; height: number | null }[] }>("/me");
      if (!me.ok) throw new Error(`GET /me failed (${me.status}): ${JSON.stringify(me.data)}`);
      const u = { id: me.data.id, name: me.data.display_name ?? me.data.id, image: pickImage(me.data.images) };
      userRef.current = u.id;
      try {
        const saved = JSON.parse(readLocal(targetsKey(u.id)) ?? "[]") as string[];
        setTargetsState(new Set(saved));
      } catch {
        /* ignore */
      }
      setUser(u);

      const [cached, cachedPlaylists] = await Promise.all([loadCache(u.id), loadPlaylistCache(u.id)]);
      if (cachedPlaylists) setPlaylists(cachedPlaylists);
      if (cached) {
        setCache(cached);
        setTracks(cached.tracks); // show cached list immediately, then sync in the background
      }
      await Promise.all([runSync(u.id, cached), refreshPlaylists(u.id)]);
    })().catch((e) => {
      const message = errMsg(e);
      if (message.includes("Not logged in") || message.includes("refresh failed")) onLogout();
      else setSync({ status: "error", message });
    });
  }, [runSync, refreshPlaylists, onLogout]);

  // "Recently updated" dates for the side panel (only fetched when that sort is used).
  const needUpdated = useCallback(async () => {
    if (!user || !playlists || updatingRef.current) return;
    updatingRef.current = true;
    try {
      const base = updated ?? (await loadUpdatedCache(user.id));
      if (!updated) setUpdated(base);
      const next = await refreshUpdated(playlists, base, (done, total) => setUpdatedProgress(total ? { done, total } : null));
      setUpdated(next);
      await saveUpdatedCache(user.id, next);
    } catch {
      /* sorting falls back to Spotify order for unknown dates */
    } finally {
      updatingRef.current = false;
      setUpdatedProgress(null);
    }
  }, [user, playlists, updated]);

  // ---------- Search + sort ----------

  // Unavailable songs stay in the cache (so counts match Spotify) but aren't shown.
  const usable = useMemo(() => (tracks ?? []).filter((t) => !isUnavailable(t)), [tracks]);
  const unavailableCount = (tracks?.length ?? 0) - usable.length;
  const haystacks = useMemo(() => usable.map(haystack), [usable]);
  const view = useMemo(() => buildView(usable, haystacks, query, sort), [usable, haystacks, query, sort]);

  const applySort = (next: SortState) => {
    setSort(next);
    writeLocal(SORT_STORAGE, JSON.stringify(next));
  };
  const changeSort = (key: SortKey, shift: boolean) => applySort(nextSort(sort, key, shift));
  const setThen = (then: SortLevel | null) => applySort({ ...sort, then });

  // ---------- Song selection ----------

  const onRowClick = (index: number, e: React.MouseEvent) => {
    const t = view[index];
    const anchorIndex = anchor ? view.findIndex((x) => x.uri === anchor) : -1;

    if (e.shiftKey && anchorIndex !== -1) {
      // Range takes the anchor's state: select the range, or deselect it if the anchor is unselected.
      const [from, to] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
      const select = selected.has(anchor!);
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = from; i <= to; i++) {
          if (select) next.add(view[i].uri);
          else next.delete(view[i].uri);
        }
        return next;
      });
      return;
    }

    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(t.uri)) next.delete(t.uri);
      else next.add(t.uri);
      return next;
    });
    setAnchor(t.uri);
  };

  const selectAllFiltered = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const t of view) next.add(t.uri);
      return next;
    });
  }, [view]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setAnchor(null);
  }, []);

  const selectedInView = useMemo(() => view.reduce((n, t) => n + (selected.has(t.uri) ? 1 : 0), 0), [view, selected]);
  const hiddenSelected = selected.size - selectedInView;

  // Songs to add: in the list's current order, then any selected songs hidden by the search.
  const orderedSelection = useCallback(() => {
    const inView = view.filter((t) => selected.has(t.uri));
    const seen = new Set(inView.map((t) => t.uri));
    return [...inView, ...usable.filter((t) => selected.has(t.uri) && !seen.has(t.uri))];
  }, [view, usable, selected]);

  const dialogTracks = useMemo(() => (dialogOpen ? orderedSelection() : []), [dialogOpen, orderedSelection]);

  // ---------- Adding to target playlists ----------

  const targetList = useMemo(() => (playlists ?? []).filter((p) => targets.has(p.id)), [playlists, targets]);
  const quickWorking = quick?.kind === "working";

  const bumpTotal = useCallback((playlistId: string, added: number) => {
    setPlaylists((prev) => prev?.map((p) => (p.id === playlistId && p.total !== null ? { ...p, total: p.total + added } : p)) ?? prev);
  }, []);

  async function quickAdd() {
    const songs = orderedSelection();
    const uris = songs.filter((t) => !t.isLocal).map((t) => t.uri);
    const results: { name: string; url: string; added: number; skipped: number }[] = [];
    const errors: string[] = [];
    for (const p of targetList) {
      try {
        setQuick({ kind: "working", text: `Checking ${p.name}…`, added: 0, total: 0 });
        const r = await addSkippingDuplicates(p.id, uris, (added, total) =>
          setQuick({ kind: "working", text: `Adding to ${p.name}…`, added, total }),
        );
        results.push({ name: p.name, url: p.url, ...r });
        bumpTotal(p.id, r.added);
        if (r.added) setUpdated((prev) => (prev ? { ...prev, [p.id]: { snapshot: null, ts: Date.now() } } : prev));
      } catch (e) {
        errors.push(`${p.name}: ${errMsg(e)}`);
      }
    }
    setQuick({ kind: "done", results, errors, skippedLocal: songs.length - uris.length });
  }

  const addLabel =
    targetList.length === 0
      ? "Add to playlist…"
      : targetList.length === 1
        ? `Add to ${targetList[0].name}`
        : `Add to ${targetList.length} playlists`;

  // ---------- Keyboard shortcuts ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open], [data-popover]")) return; // dialogs/menus handle their own keys
      const inField = !!(e.target as HTMLElement | null)?.closest("input, textarea, select");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !inField) {
        e.preventDefault();
        selectAllFiltered();
      } else if (e.key === "Escape") {
        if (inField && query) setQuery("");
        else if (inField) (e.target as HTMLElement).blur();
        else clearSelection();
      } else if (e.key === "/" && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectAllFiltered, clearSelection, query]);

  // ---------- Render ----------

  const syncing = sync.status === "syncing";
  const p = sync.status === "syncing" ? sync.progress : null;

  return (
    <div className={`app ${animate ? "animate" : ""}`}>
      <header className="topbar">
        <button
          className="icon-btn hamburger"
          onClick={() => toggleSidebar(!sidebarOpen)}
          aria-label={sidebarOpen ? "Hide playlists panel" : "Show playlists panel"}
          aria-expanded={sidebarOpen}
          title="Your playlists"
        >
          <Icon name="menu" size={20} />
          {targets.size > 0 && <span className="dot-badge">{targets.size}</span>}
        </button>
        <strong className="brand">Playlist Maker</strong>
        <div className="sync">
          {syncing && (
            <>
              <span className="muted">
                {p?.mode === "full"
                  ? `Loading ${p.loaded.toLocaleString()} / ${p.total.toLocaleString()}`
                  : "Checking for new songs…"}
              </span>
              {p?.mode === "full" && <progress value={p.loaded} max={p.total} />}
            </>
          )}
          {sync.status === "done" && <span className="muted">{sync.message}</span>}
          {sync.status === "error" && (
            <span className="bad" title={sync.message}>
              Sync failed
            </span>
          )}
          <button
            className="secondary small"
            disabled={syncing || !user}
            onClick={() => user && runSync(user.id, null)}
            title="Re-download all liked songs"
          >
            Reload all
          </button>
        </div>
        <div className="hstack user-box">
          <button className="secondary small" onClick={onLogout}>
            Log out
          </button>
          {user && (
            <span className="user-chip" title={user.name}>
              <span className="avatar">
                {user.image ? <img src={user.image} alt="" width={28} height={28} /> : <span>{user.name.slice(0, 1).toUpperCase()}</span>}
              </span>
              <span className="user-name">{user.name}</span>
            </span>
          )}
        </div>
      </header>

      <div className="body">
        <div className={`sidebar-backdrop ${sidebarOpen ? "open" : ""}`} onClick={() => toggleSidebar(false)} />
        <div className={`sidebar-shell ${sidebarOpen ? "open" : ""}`} inert={!sidebarOpen}>
          <Sidebar
            userId={user?.id ?? null}
            playlists={playlists}
            loading={playlistsLoading}
            error={playlistsError}
            targets={targets}
            setTargets={setTargets}
            onRefresh={() => user && refreshPlaylists(user.id)}
            onClose={() => toggleSidebar(false)}
            updated={updated}
            updatedProgress={updatedProgress}
            onNeedUpdated={needUpdated}
          />
        </div>

        <main className="main-panel">
          <div className="toolbar">
            <input
              ref={searchRef}
              type="search"
              className="search"
              placeholder="Search title, artist, album  ( / )"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="muted counts">
              {tracks
                ? query
                  ? `${view.length.toLocaleString()} of ${usable.length.toLocaleString()}`
                  : `${usable.length.toLocaleString()} songs`
                : ""}
            </span>
            <div className="spacer" />
            <span className={selected.size ? "sel-count" : "muted"}>
              {selected.size.toLocaleString()} selected
              {hiddenSelected > 0 && <span className="muted"> ({hiddenSelected} hidden by search)</span>}
            </span>
            <button className="secondary small" onClick={selectAllFiltered} disabled={!view.length} title="Ctrl/Cmd+A">
              Select all{query ? " shown" : ""}
            </button>
            <button className="secondary small" onClick={clearSelection} disabled={!selected.size} title="Esc">
              Clear
            </button>
            {targetList.length > 0 && (
              <button
                className="secondary small"
                onClick={() => setDialogOpen(true)}
                disabled={!selected.size || quickWorking}
                title="Create a new playlist or pick a different one"
              >
                Other…
              </button>
            )}
            <button
              className="small add-btn"
              onClick={() => (targetList.length ? quickAdd() : setDialogOpen(true))}
              disabled={!selected.size || !user || quickWorking}
              title={targetList.length ? `Skips songs already in ${targetList.length === 1 ? "the playlist" : "each playlist"}` : undefined}
            >
              {addLabel}
            </button>
          </div>

          {sync.status === "error" && (
            <div className="error-banner">
              <span className="bad">Sync failed:</span> <code>{sync.message}</code>
            </div>
          )}

          {tracks ? (
            <TrackList
              view={view}
              selected={selected}
              sort={sort}
              onSort={changeSort}
              onSetThen={setThen}
              onRowClick={onRowClick}
              resetScrollKey={`${query}|${sort.key}|${sort.dir}|${sort.then?.key}|${sort.then?.dir}`}
            />
          ) : (
            <div className="empty muted">{syncing ? "Loading your liked songs…" : ""}</div>
          )}

          {quick ? (
            <div className="status-bar" role="status">
              {quick.kind === "working" ? (
                <>
                  <span>{quick.text}</span>
                  {quick.total > 0 && (
                    <>
                      <progress value={quick.added} max={quick.total} />
                      <span className="muted">
                        {quick.added} / {quick.total}
                      </span>
                    </>
                  )}
                </>
              ) : (
                <>
                  <span className="status-text">
                    {quick.results.map((r, i) => (
                      <span key={i}>
                        {i > 0 && " · "}
                        Added {r.added} to{" "}
                        <a href={r.url} target="_blank" rel="noreferrer">
                          {r.name}
                        </a>
                        {r.skipped > 0 && <span className="muted"> ({r.skipped} already there)</span>}
                      </span>
                    ))}
                    {quick.skippedLocal > 0 && <span className="muted"> · {quick.skippedLocal} local files skipped</span>}
                    {quick.errors.map((e, i) => (
                      <span key={`e${i}`} className="bad" title={e}>
                        {" "}
                        · Failed: {e.split(":")[0]}
                      </span>
                    ))}
                  </span>
                  <div className="spacer" />
                  <button
                    className="secondary small"
                    onClick={() => {
                      clearSelection();
                      setQuick(null);
                    }}
                  >
                    Clear selection
                  </button>
                  <button className="icon-btn" onClick={() => setQuick(null)} aria-label="Dismiss">
                    ✕
                  </button>
                </>
              )}
            </div>
          ) : (
            cache && (
              <footer className="footer">
                <span className="footer-status">
                  Synced {formatSynced(cache.syncedAt)}
                  {unavailableCount > 0 && ` · ${unavailableCount} unavailable song${unavailableCount === 1 ? "" : "s"} hidden`}
                </span>
                <span className="shortcuts">
                  <span><kbd>Click</kbd> select</span>
                  <span><kbd>Shift</kbd>+<kbd>Click</kbd> range</span>
                  <span><kbd>Ctrl</kbd>+<kbd>A</kbd> all shown</span>
                  <span><kbd>Esc</kbd> clear</span>
                  <span><kbd>/</kbd> search</span>
                  <span className="tip">☰ Tick playlists to add in one click · drag one onto another to make a folder</span>
                </span>
              </footer>
            )
          )}
        </main>
      </div>

      {dialogOpen && user && (
        <AddToPlaylistDialog
          tracks={dialogTracks}
          playlists={playlists}
          playlistsError={playlistsError}
          onCreated={(created) => {
            setPlaylists((prev) => [created, ...(prev ?? [])]);
            if (user) savePlaylistCache(user.id, [created, ...(playlists ?? [])]);
          }}
          onAdded={bumpTotal}
          onClose={() => setDialogOpen(false)}
          onClearSelection={clearSelection}
        />
      )}
    </div>
  );
}
