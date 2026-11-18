"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PlaylistSummary, UpdatedCache } from "@/lib/playlists";
import {
  buildTree,
  createFolderAt,
  deleteFolder,
  EMPTY_FOLDERS,
  flattenTree,
  folderPath,
  groupPlaylists,
  isWithin,
  itemParent,
  keyOf,
  loadFolders,
  nodeKey,
  placeItem,
  playlistParent,
  renameFolder,
  sanitizeFolders,
  saveFolders,
  setCollapsed,
  type FolderNode,
  type FolderState,
  type Placement,
} from "@/lib/folders";
import Icon from "./Icon";

type Props = {
  userId: string | null;
  playlists: PlaylistSummary[] | null;
  loading: boolean;
  error: string | null;
  targets: Set<string>;
  setTargets: (update: (prev: Set<string>) => Set<string>) => void;
  onRefresh: () => void;
  onClose: () => void;
  updated: UpdatedCache | null;
  updatedProgress: { done: number; total: number } | null;
  onNeedUpdated: () => void;
};

type PlSort = "custom" | "name" | "recent";
type DragItem = { kind: "playlist" | "folder"; id: string; label: string };
type DropVisual = { key: string; cls: "drop-into" | "drop-before" | "drop-after" } | null;
type DropTarget =
  | { kind: "group"; id: string; vis: DropVisual } // playlist onto playlist -> new folder
  | { kind: "into"; id: string; vis: DropVisual } // onto a folder
  | { kind: "level"; id: string | null; vis: DropVisual } // empty space / breadcrumb
  | { kind: "between"; at: Placement; vis: DropVisual }; // reorder (custom order only)

const PL_SORT_STORAGE = "pm_playlist_sort";
const LONG_PRESS_MS = 350;
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export default function Sidebar({
  userId,
  playlists,
  loading,
  error,
  targets,
  setTargets,
  onRefresh,
  onClose,
  updated,
  updatedProgress,
  onNeedUpdated,
}: Props) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<PlSort>("custom");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<(DragItem & { x: number; y: number }) | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);
  const suppressClick = useRef(false);
  const cancelRename = useRef(false);

  // ---------- Folder state (persisted per user) ----------

  const [fs, setFs] = useState<FolderState>(EMPTY_FOLDERS);
  const fsRef = useRef(fs);
  fsRef.current = fs;

  useEffect(() => {
    if (userId) setFs(loadFolders(userId));
  }, [userId]);

  const commit = useCallback(
    (next: FolderState | null) => {
      if (!next || next === fsRef.current) return;
      fsRef.current = next;
      setFs(next);
      if (userId) saveFolders(userId, next);
    },
    [userId],
  );

  // ---------- Sorting ----------

  useEffect(() => {
    try {
      const s = localStorage.getItem(PL_SORT_STORAGE);
      if (s === "name" || s === "recent") setSort(s); // anything else (incl. old "spotify") = custom
    } catch {
      /* ignore */
    }
  }, []);

  const changeSort = (s: PlSort) => {
    setSort(s);
    try {
      localStorage.setItem(PL_SORT_STORAGE, s);
    } catch {
      /* ignore */
    }
  };

  const needUpdatedRef = useRef(onNeedUpdated);
  needUpdatedRef.current = onNeedUpdated;
  useEffect(() => {
    if (sort === "recent" && playlists) needUpdatedRef.current();
  }, [sort, playlists]);

  // ---------- Tree ----------

  const zoomId = zoom && fs.folders[zoom] ? zoom : null;
  const zoomPath = useMemo(() => folderPath(fs, zoomId), [fs, zoomId]);
  const spotifyIndex = useMemo(() => new Map((playlists ?? []).map((p, i) => [p.id, i])), [playlists]);
  // The custom-ordered tree is always needed: moves are expressed relative to it.
  const customTree = useMemo(
    () => buildTree(fs, playlists ?? [], { mode: "custom", spotifyIndex }),
    [fs, playlists, spotifyIndex],
  );
  const tree = useMemo(
    () => (sort === "custom" ? customTree : buildTree(fs, playlists ?? [], { mode: sort, spotifyIndex, updated })),
    [sort, customTree, fs, playlists, spotifyIndex, updated],
  );
  const customTreeRef = useRef(customTree);
  customTreeRef.current = customTree;
  const levelKeys = (parentId: string | null) =>
    (parentId ? (customTreeRef.current.byId.get(parentId)?.children ?? []) : customTreeRef.current.roots).map(nodeKey);
  const levelNodes = zoomId ? (tree.byId.get(zoomId)?.children ?? []) : tree.roots;
  const filtering = filter.trim().length > 0;
  const rows = useMemo(
    () => flattenTree(levelNodes, filter, zoomPath.map((f) => f.name)),
    [levelNodes, filter, zoomPath],
  );
  const visiblePlaylistIds = useMemo(
    () => rows.flatMap((r) => (r.node.kind === "playlist" ? [r.node.playlist.id] : [])),
    [rows],
  );

  // ---------- Target selection (square buttons only) ----------

  const togglePlaylist = (id: string, shift: boolean) => {
    const idx = visiblePlaylistIds.indexOf(id);
    const aIdx = anchor ? visiblePlaylistIds.indexOf(anchor) : -1;
    if (shift && aIdx !== -1 && idx !== -1) {
      const [from, to] = aIdx < idx ? [aIdx, idx] : [idx, aIdx];
      const select = targets.has(anchor!);
      setTargets((prev) => {
        const next = new Set(prev);
        for (let i = from; i <= to; i++) {
          if (select) next.add(visiblePlaylistIds[i]);
          else next.delete(visiblePlaylistIds[i]);
        }
        return next;
      });
      return;
    }
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
  };

  const toggleFolderTargets = (node: FolderNode) => {
    const ids = node.playlistIds;
    const all = ids.length > 0 && ids.every((id) => targets.has(id));
    setTargets((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  // ---------- Folder actions ----------

  const newFolder = () => {
    const [next, id] = createFolderAt(fsRef.current, null, levelKeys(null));
    commit(next);
    setZoom(null);
    setRenaming(id);
  };

  const toggleCollapsed = (id: string) => {
    const f = fsRef.current.folders[id];
    if (f) commit(setCollapsed(fsRef.current, id, !f.collapsed));
  };

  const removeFolder = (id: string) => {
    const f = fsRef.current.folders[id];
    if (!f) return;
    if (!window.confirm(`Delete folder "${f.name}"? Its playlists move up one level (nothing is deleted in Spotify).`)) return;
    commit(deleteFolder(fsRef.current, id, levelKeys(id), levelKeys(f.parentId)));
  };

  const finishRename = (id: string, value: string) => {
    if (!cancelRename.current) commit(renameFolder(fsRef.current, id, value));
    cancelRename.current = false;
    setRenaming(null);
  };

  // ---------- Drag and drop (pointer-based, works with mouse and touch) ----------

  const resolveDrop = (x: number, y: number, item: DragItem): DropTarget | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-kind]");
    if (!el) return null;
    const s = fsRef.current;
    const kind = el.dataset.dropKind;
    const currentParent = itemParent(s, item);
    const custom = sort === "custom";

    if (kind === "level") {
      const id = el.dataset.dropId || null;
      if (id === currentParent || (item.kind === "folder" && id)) return null;
      return { kind: "level", id, vis: null };
    }

    const id = el.dataset.dropId!;
    const key = el.dataset.key!;
    const rowParent = el.dataset.parent || null;
    if (key === keyOf(item)) return null;
    const r = el.getBoundingClientRect();
    const rel = (y - r.top) / r.height;
    const half = rel < 0.5 ? "before" : "after";
    const between = (at: Placement, cls: "drop-before" | "drop-after"): DropTarget => ({ kind: "between", at, vis: { key, cls } });

    // Folders stay at the top level: they can only be reordered among top-level rows.
    if (item.kind === "folder") {
      if (!custom || rowParent) return null;
      return between({ parentId: null, ref: key, where: half }, half === "before" ? "drop-before" : "drop-after");
    }

    // A playlist over a row inside a folder: reorder there (custom order), or just move into that folder.
    if (rowParent) {
      if (custom) return between({ parentId: rowParent, ref: key, where: half }, half === "before" ? "drop-before" : "drop-after");
      if (currentParent === rowParent) return null;
      return { kind: "into", id: rowParent, vis: { key: `f:${rowParent}`, cls: "drop-into" } };
    }

    // A playlist over a top-level row: edges reorder (custom order), middle groups / moves in.
    if (custom) {
      const where = rel < 0.25 ? "before" : rel > 0.75 ? "after" : null;
      if (where) {
        const at: Placement =
          kind === "folder" && where === "after" && el.dataset.expanded === "1"
            ? { parentId: id, ref: null, where: "start" } // just below an open folder = its first item
            : { parentId: null, ref: key, where };
        return between(at, where === "before" ? "drop-before" : "drop-after");
      }
    }
    if (kind === "playlist") return { kind: "group", id, vis: { key, cls: "drop-into" } };
    if (id === currentParent) return null;
    return { kind: "into", id, vis: { key, cls: "drop-into" } };
  };

  const applyDrop = (item: DragItem, target: DropTarget) => {
    const s = fsRef.current;
    const ref = { kind: item.kind, id: item.id };
    if (target.kind === "group") {
      const [next, fid] = groupPlaylists(s, target.id, item.id, levelKeys(playlistParent(s, target.id)));
      commit(next);
      setRenaming(fid);
    } else if (target.kind === "into") {
      const next = placeItem(s, ref, { parentId: target.id, ref: null, where: "end" }, levelKeys(target.id));
      commit(next && setCollapsed(next, target.id, false));
    } else if (target.kind === "level") {
      commit(placeItem(s, ref, { parentId: target.id, ref: null, where: "end" }, levelKeys(target.id)));
    } else {
      commit(placeItem(s, ref, target.at, levelKeys(target.at.parentId)));
    }
  };

  const autoScroll = (y: number) => {
    const el = listRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (y < r.top + 40) el.scrollTop -= 12;
    else if (y > r.bottom - 40) el.scrollTop += 12;
  };

  const startGesture = (e: React.PointerEvent, item: DragItem) => {
    if (e.button !== 0 || renaming) return;
    if ((e.target as HTMLElement).closest("button, input")) return;
    const touch = e.pointerType === "touch";
    const sx = e.clientX;
    const sy = e.clientY;
    let started = false;
    let timer: number | null = null;

    const begin = (x: number, y: number) => {
      started = true;
      draggingRef.current = true;
      setDrag({ ...item, x, y });
      if (touch) navigator.vibrate?.(15);
    };
    const move = (ev: PointerEvent) => {
      if (!started) {
        const dist = Math.hypot(ev.clientX - sx, ev.clientY - sy);
        if (touch) {
          if (dist > 8) cleanup(); // it's a scroll, not a long-press
          return;
        }
        if (dist < 5) return;
        begin(ev.clientX, ev.clientY);
      }
      setDrag((d) => d && { ...d, x: ev.clientX, y: ev.clientY });
      setDrop(resolveDrop(ev.clientX, ev.clientY, item));
      autoScroll(ev.clientY);
    };
    const up = (ev: PointerEvent) => {
      if (started) {
        const target = resolveDrop(ev.clientX, ev.clientY, item);
        if (target) applyDrop(item, target);
        suppressClick.current = true;
        window.setTimeout(() => (suppressClick.current = false), 0);
      }
      cleanup();
    };
    function cleanup() {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cleanup);
      draggingRef.current = false;
      setDrag(null);
      setDrop(null);
    }

    if (touch) timer = window.setTimeout(() => begin(sx, sy), LONG_PRESS_MS);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cleanup);
  };

  // While dragging on touch, stop the page from scrolling instead.
  useEffect(() => {
    const onTouchMove = (e: TouchEvent) => {
      if (draggingRef.current) e.preventDefault();
    };
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => document.removeEventListener("touchmove", onTouchMove);
  }, []);

  const isLevelDrop = (id: string | null) => drop?.kind === "level" && drop.id === id;
  const rowDrop = (key: string) => (drop?.vis?.key === key ? drop.vis.cls : "");

  const dropHint = !drag
    ? null
    : !drop
      ? sort === "custom"
        ? "Drop between rows to reorder · on a playlist to make a folder · on a folder to move in"
        : "Drop on a playlist to make a folder · on a folder to move in"
      : drop.kind === "group"
        ? "Release to make a new folder with both"
        : drop.kind === "into"
          ? `Move into "${fs.folders[drop.id]?.name}"`
          : drop.kind === "level"
            ? `Move to ${drop.id ? `"${fs.folders[drop.id]?.name}"` : "the top level"}`
            : "Release to move here";

  // ---------- Export / import ----------

  const exportFolders = () => {
    const blob = new Blob([JSON.stringify({ app: "playlist-maker", version: 1, ...fs }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "playlist-folders.json";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importFolders = async (file: File) => {
    try {
      const next = sanitizeFolders(JSON.parse(await file.text()));
      if (!Object.keys(next.folders).length) throw new Error("No folders found in that file.");
      if (window.confirm(`Replace your current folders with ${Object.keys(next.folders).length} folders from the file?`)) {
        commit(next);
        setZoom(null);
      }
    } catch (e) {
      window.alert(`Couldn't import: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---------- Render ----------

  const guides = (depth: number) =>
    depth > 0 ? (
      <span className="guides" aria-hidden="true">
        {Array.from({ length: depth }, (_, i) => (
          <span key={i} className="guide" />
        ))}
      </span>
    ) : null;

  return (
    <aside className="sidebar" aria-label="Your playlists">
      <div className="sidebar-head">
        <span className="sidebar-title">Your playlists</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={newFolder} title="New folder" aria-label="New folder">
          <Icon name="folderPlus" />
        </button>
        <button className="icon-btn" onClick={onRefresh} disabled={loading} title="Reload playlists from Spotify" aria-label="Reload playlists">
          <Icon name="refresh" />
        </button>
        <button className="icon-btn" onClick={onClose} title="Close panel" aria-label="Close panel">
          <Icon name="close" />
        </button>
      </div>

      <div className="sidebar-tools">
        <input
          type="search"
          className="search"
          placeholder="Filter playlists & folders"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select value={sort} onChange={(e) => changeSort(e.target.value as PlSort)} aria-label="Sort playlists">
          <option value="custom">Custom order</option>
          <option value="recent">Recently updated</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      {zoomId && (
        <nav className="crumbs" aria-label="Open folder">
          <button
            className={`icon-btn ${isLevelDrop(null) ? "drop-into" : ""}`}
            data-drop-kind="level"
            data-drop-id=""
            onClick={() => setZoom(null)}
            title="Back to all playlists (drop here to take a playlist out)"
            aria-label="Back to all playlists"
          >
            <Icon name="chevronLeft" />
          </button>
          <span className="folder-icon small">
            <Icon name="folder" size={14} />
          </span>
          <span className="crumb current">{fs.folders[zoomId]?.name}</span>
        </nav>
      )}

      {(dropHint || (sort === "recent" && updatedProgress) || targets.size > 0) && (
        <div className="sidebar-status">
          {dropHint ? (
            <span className="drop-hint">{dropHint}</span>
          ) : sort === "recent" && updatedProgress ? (
            <span className="muted">
              Checking update dates… {updatedProgress.done}/{updatedProgress.total}
            </span>
          ) : (
            <>
              <span>
                <strong>{targets.size}</strong> selected as target{targets.size === 1 ? "" : "s"}
              </span>
              <button className="link-btn" onClick={() => setTargets(() => new Set())}>
                Clear
              </button>
            </>
          )}
        </div>
      )}

      <div
        ref={listRef}
        className={`pl-list ${drag ? "dragging" : ""} ${isLevelDrop(zoomId) ? "drop-level" : ""}`}
        role="tree"
        aria-multiselectable="true"
        data-drop-kind="level"
        data-drop-id={zoomId ?? ""}
      >
        {error && <p className="bad pad">{error}</p>}
        {!playlists && !error && <p className="muted pad">Loading playlists…</p>}
        {playlists && !rows.length && <p className="muted pad">{filtering ? "Nothing matches." : "This folder is empty."}</p>}

        {rows.map(({ node, depth }) => {
          if (node.kind === "folder") {
            const f = node.folder;
            const ids = node.playlistIds;
            const nSel = ids.filter((id) => targets.has(id)).length;
            const state = nSel === 0 ? "" : nSel === ids.length ? "on" : "partial";
            const expanded = filtering || !f.collapsed;
            return (
              <div
                key={f.id}
                role="treeitem"
                aria-expanded={expanded}
                aria-level={depth + 1}
                className={`pl-row folder ${rowDrop(`f:${f.id}`)} ${drag?.id === f.id ? "is-dragged" : ""}`}
                data-drop-kind="folder"
                data-drop-id={f.id}
                data-key={`f:${f.id}`}
                data-parent={f.parentId ?? ""}
                data-expanded={expanded ? "1" : "0"}
                onPointerDown={(e) => startGesture(e, { kind: "folder", id: f.id, label: f.name })}
                onClick={() => !suppressClick.current && !filtering && renaming !== f.id && toggleCollapsed(f.id)}
                onDoubleClick={() => renaming !== f.id && setZoom(f.id)}
                onContextMenu={(e) => e.preventDefault()}
                title="Click to expand/collapse · double-click to open"
              >
                {guides(depth)}
                <button
                  className={`chev ${expanded ? "open" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!filtering) toggleCollapsed(f.id);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  aria-label={expanded ? "Collapse" : "Expand"}
                >
                  <Icon name="chevronRight" size={16} />
                </button>
                <span className="folder-icon">
                  <Icon name="folder" size={20} />
                </span>
                {renaming === f.id ? (
                  <input
                    className="rename"
                    autoFocus
                    defaultValue={f.name}
                    onFocus={(e) => e.target.select()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") {
                        cancelRename.current = true;
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    onBlur={(e) => finishRename(f.id, e.target.value)}
                    aria-label="Folder name"
                  />
                ) : (
                  <span className="pl-text">
                    <span className="pl-name">{f.name}</span>
                    <span className="pl-sub">
                      Folder · {ids.length} playlist{ids.length === 1 ? "" : "s"}
                    </span>
                  </span>
                )}
                <span className="row-actions">
                  <button
                    className="icon-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenaming(f.id);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title="Rename"
                    aria-label="Rename folder"
                  >
                    <Icon name="pencil" size={15} />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFolder(f.id);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title="Delete folder (keeps its playlists)"
                    aria-label="Delete folder"
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </span>
                <button
                  className={`check ${state}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFolderTargets(node);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  disabled={!ids.length}
                  aria-label={state === "on" ? "Unselect all playlists in folder" : "Select all playlists in folder"}
                  aria-pressed={state === "on" ? true : state === "partial" ? "mixed" : false}
                >
                  {state === "on" ? "✓" : state === "partial" ? "–" : ""}
                </button>
              </div>
            );
          }

          const p = node.playlist;
          const on = targets.has(p.id);
          return (
            <div
              key={p.id}
              role="treeitem"
              aria-selected={on}
              aria-level={depth + 1}
              className={`pl-row ${on ? "on" : ""} ${rowDrop(`p:${p.id}`)} ${drag?.id === p.id ? "is-dragged" : ""}`}
              data-drop-kind="playlist"
              data-drop-id={p.id}
              data-key={`p:${p.id}`}
              data-parent={playlistParent(fs, p.id) ?? ""}
              onPointerDown={(e) => startGesture(e, { kind: "playlist", id: p.id, label: p.name })}
              onContextMenu={(e) => e.preventDefault()}
              title={p.name}
            >
              {guides(depth)}
              <span className="chev-spacer" />
              {p.image ? (
                <img className="pl-cover" src={p.image} alt="" width={40} height={40} loading="lazy" draggable={false} />
              ) : (
                <span className="pl-cover cover-ph" />
              )}
              <span className="pl-text">
                <span className="pl-name">{p.name}</span>
                <span className="pl-sub">
                  {p.total !== null ? `${p.total.toLocaleString()} song${p.total === 1 ? "" : "s"}` : "Playlist"}
                  {sort === "recent" && updated?.[p.id]?.ts ? ` · ${new Date(updated[p.id].ts).toLocaleDateString()}` : ""}
                </span>
              </span>
              <button
                className={`check ${on ? "on" : ""}`}
                onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePlaylist(p.id, e.shiftKey);
                }}
                aria-label={on ? `Unselect ${p.name}` : `Select ${p.name}`}
                aria-pressed={on}
              >
                {on ? "✓" : ""}
              </button>
            </div>
          );
        })}
        <div className="pl-list-end" />
      </div>

      <div className="sidebar-foot">
        <button className="link-btn" onClick={exportFolders} title="Save your folders to a file">
          <Icon name="download" size={13} /> Export folders
        </button>
        <button className="link-btn" onClick={() => fileRef.current?.click()} title="Load folders from a file">
          <Icon name="upload" size={13} /> Import folders
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importFolders(f);
            e.target.value = "";
          }}
        />
      </div>

      {drag &&
        createPortal(
          <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 10 }}>
            <Icon name={drag.kind === "folder" ? "folder" : "menu"} size={14} /> {drag.label}
          </div>,
          document.body,
        )}
    </aside>
  );
}
