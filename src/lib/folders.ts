// App-side playlist folders. Spotify's Web API doesn't expose the folders from the Spotify
// app, so these live only in this browser (localStorage), with export/import as a backup.
// Folders are one level deep: they live at the top level and contain only playlists.
//
// Ordering: each level (the top level, or a folder) has an optional list of item keys
// ("f:<folderId>" / "p:<playlistId>"). Items not in the list yet (e.g. playlists you just
// made in Spotify) come first, in Spotify's order — the way Spotify puts new playlists on top.

import type { PlaylistSummary } from "./playlists";
import { normalize } from "./view";

export type Folder = { id: string; name: string; parentId: string | null; collapsed: boolean };
export type FolderState = {
  folders: Record<string, Folder>;
  parentOf: Record<string, string>; // playlistId -> folderId (absent = top level)
  order: Record<string, string[]>; // levelKey ("" = top level, else folderId) -> item keys
};

export type ItemRef = { kind: "playlist" | "folder"; id: string };
export type Placement = { parentId: string | null; ref: string | null; where: "before" | "after" | "start" | "end" };

export const EMPTY_FOLDERS: FolderState = { folders: {}, parentOf: {}, order: {} };

export const keyOf = (r: ItemRef) => `${r.kind === "folder" ? "f" : "p"}:${r.id}`;
const levelKey = (parentId: string | null) => parentId ?? "";
const storageKey = (userId: string) => `pm_folders:${userId}`;

export function sanitizeFolders(raw: unknown): FolderState {
  const r = raw as Partial<FolderState> | null;
  if (!r || typeof r !== "object" || typeof r.folders !== "object" || typeof r.parentOf !== "object") return EMPTY_FOLDERS;
  const folders: Record<string, Folder> = {};
  for (const [id, f] of Object.entries(r.folders ?? {})) {
    if (!f || typeof f.name !== "string") continue;
    folders[id] = { id, name: f.name, parentId: null, collapsed: !!f.collapsed }; // no nesting (older nested data is flattened)
  }
  const parentOf: Record<string, string> = {};
  for (const [pid, fid] of Object.entries(r.parentOf ?? {})) if (typeof fid === "string" && folders[fid]) parentOf[pid] = fid;
  const order: Record<string, string[]> = {};
  for (const [lk, list] of Object.entries(r.order ?? {})) {
    if ((lk === "" || folders[lk]) && Array.isArray(list)) order[lk] = list.filter((k): k is string => typeof k === "string");
  }
  return { folders, parentOf, order };
}

export function loadFolders(userId: string): FolderState {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw ? sanitizeFolders(JSON.parse(raw)) : EMPTY_FOLDERS;
  } catch {
    return EMPTY_FOLDERS;
  }
}

export function saveFolders(userId: string, s: FolderState) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function newId(): string {
  return `f_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

// ---------- Queries ----------

export function playlistParent(s: FolderState, playlistId: string): string | null {
  const fid = s.parentOf[playlistId];
  return fid && s.folders[fid] ? fid : null;
}

export function itemParent(s: FolderState, item: ItemRef): string | null {
  return item.kind === "playlist" ? playlistParent(s, item.id) : (s.folders[item.id]?.parentId ?? null);
}

/** Root-first chain of folders ending at folderId. */
export function folderPath(s: FolderState, folderId: string | null): Folder[] {
  const out: Folder[] = [];
  let cur = folderId ? s.folders[folderId] : undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? s.folders[cur.parentId] : undefined;
  }
  return out;
}

/** True if `folderId` is `ancestorId` or somewhere inside it. */
export function isWithin(s: FolderState, folderId: string | null, ancestorId: string): boolean {
  return folderPath(s, folderId).some((f) => f.id === ancestorId);
}

// ---------- Mutations (all return a new state) ----------
// `levelKeys` arguments are the level's current custom order (from the custom-ordered tree),
// so a partially-ordered level gets fully pinned down the first time it's rearranged.

function withoutKey(order: Record<string, string[]>, key: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [lk, list] of Object.entries(order)) out[lk] = list.filter((k) => k !== key);
  return out;
}

function reparent(s: FolderState, item: ItemRef, parentId: string | null): FolderState {
  if (item.kind === "playlist") {
    const parentOf = { ...s.parentOf };
    if (parentId) parentOf[item.id] = parentId;
    else delete parentOf[item.id];
    return { ...s, parentOf };
  }
  const f = s.folders[item.id];
  return f ? { ...s, folders: { ...s.folders, [item.id]: { ...f, parentId } } } : s;
}

/** Moves an item to a level, at a position. Returns null if invalid (folder into itself) or a no-op. */
export function placeItem(s: FolderState, item: ItemRef, at: Placement, destLevelKeys: string[]): FolderState | null {
  if (item.kind === "folder" && at.parentId) return null; // folders only live at the top level
  const key = keyOf(item);
  const list = destLevelKeys.filter((k) => k !== key);
  let idx = list.length;
  if (at.where === "start") idx = 0;
  else if ((at.where === "before" || at.where === "after") && at.ref) {
    const r = list.indexOf(at.ref);
    if (r !== -1) idx = r + (at.where === "after" ? 1 : 0);
  }
  list.splice(idx, 0, key);

  const sameLevel = itemParent(s, item) === at.parentId;
  if (sameLevel && list.join("|") === destLevelKeys.join("|")) return null;

  const moved = reparent(s, item, at.parentId);
  return { ...moved, order: { ...withoutKey(s.order, key), [levelKey(at.parentId)]: list } };
}

/** New empty folder at the top of a level. */
export function createFolderAt(s: FolderState, parentId: string | null, levelKeys: string[], name = "New folder"): [FolderState, string] {
  const id = newId();
  return [
    {
      ...s,
      folders: { ...s.folders, [id]: { id, name, parentId, collapsed: false } },
      order: { ...s.order, [levelKey(parentId)]: [`f:${id}`, ...levelKeys] },
    },
    id,
  ];
}

/** Phone-style grouping: dropping a playlist on another makes a folder, in the stationary one's spot. */
export function groupPlaylists(s: FolderState, targetId: string, draggedId: string, targetLevelKeys: string[]): [FolderState, string] {
  const parentId = playlistParent(s, targetId);
  const id = newId();
  const tKey = `p:${targetId}`;
  const dKey = `p:${draggedId}`;
  const level = targetLevelKeys.filter((k) => k !== dKey).map((k) => (k === tKey ? `f:${id}` : k));

  let next: FolderState = { ...s, folders: { ...s.folders, [id]: { id, name: "New folder", parentId, collapsed: false } } };
  next = reparent(reparent(next, { kind: "playlist", id: targetId }, id), { kind: "playlist", id: draggedId }, id);
  next.order = { ...withoutKey(withoutKey(s.order, dKey), tKey), [levelKey(parentId)]: level, [id]: [tKey, dKey] };
  return [next, id];
}

export function renameFolder(s: FolderState, id: string, name: string): FolderState {
  const f = s.folders[id];
  if (!f) return s;
  return { ...s, folders: { ...s.folders, [id]: { ...f, name: name.trim() || f.name } } };
}

export function setCollapsed(s: FolderState, id: string, collapsed: boolean): FolderState {
  const f = s.folders[id];
  if (!f || f.collapsed === collapsed) return s;
  return { ...s, folders: { ...s.folders, [id]: { ...f, collapsed } } };
}

/** Deletes a folder; its contents move up one level, into the folder's old spot. */
export function deleteFolder(s: FolderState, id: string, childKeys: string[], parentLevelKeys: string[]): FolderState {
  const f = s.folders[id];
  if (!f) return s;
  const folders = { ...s.folders };
  delete folders[id];
  for (const child of Object.values(folders)) if (child.parentId === id) folders[child.id] = { ...child, parentId: f.parentId };
  const parentOf: Record<string, string> = {};
  for (const [pid, fid] of Object.entries(s.parentOf)) {
    if (fid !== id) parentOf[pid] = fid;
    else if (f.parentId) parentOf[pid] = f.parentId;
  }
  const order = { ...s.order };
  delete order[id];
  order[levelKey(f.parentId)] = parentLevelKeys.flatMap((k) => (k === `f:${id}` ? childKeys : [k]));
  return { folders, parentOf, order };
}

// ---------- Tree ----------

export type FolderNode = { kind: "folder"; folder: Folder; children: TreeNode[]; playlistIds: string[]; ts: number };
export type PlaylistNode = { kind: "playlist"; playlist: PlaylistSummary };
export type TreeNode = FolderNode | PlaylistNode;
export type Row = { node: TreeNode; depth: number };
export type TreeMode = "custom" | "name" | "recent";

export const nodeKey = (n: TreeNode) => (n.kind === "folder" ? `f:${n.folder.id}` : `p:${n.playlist.id}`);

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function buildTree(
  s: FolderState,
  playlists: PlaylistSummary[],
  opts: { mode: TreeMode; spotifyIndex: Map<string, number>; updated?: Record<string, { ts: number }> | null },
): { roots: TreeNode[]; byId: Map<string, FolderNode> } {
  const byId = new Map<string, FolderNode>();
  for (const f of Object.values(s.folders)) byId.set(f.id, { kind: "folder", folder: f, children: [], playlistIds: [], ts: 0 });

  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.folder.parentId ? byId.get(node.folder.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  for (const p of playlists) {
    const parent = byId.get(s.parentOf[p.id] ?? "");
    (parent ? parent.children : roots).push({ kind: "playlist", playlist: p });
  }

  const name = (n: TreeNode) => (n.kind === "folder" ? n.folder.name : n.playlist.name);
  const ts = (n: TreeNode) => (n.kind === "folder" ? n.ts : (opts.updated?.[n.playlist.id]?.ts ?? -1));
  const spotify = (n: TreeNode) => (n.kind === "playlist" ? (opts.spotifyIndex.get(n.playlist.id) ?? 0) : -1);

  const finish = (nodes: TreeNode[], parentId: string | null): { ids: string[]; ts: number } => {
    for (const n of nodes) {
      if (n.kind === "folder") {
        const r = finish(n.children, n.folder.id);
        n.playlistIds = r.ids;
        n.ts = r.ts;
      }
    }

    if (opts.mode === "name") nodes.sort((a, b) => collator.compare(name(a), name(b)));
    else if (opts.mode === "recent") nodes.sort((a, b) => ts(b) - ts(a) || spotify(a) - spotify(b));
    else {
      const pos = new Map((s.order[levelKey(parentId)] ?? []).map((k, i) => [k, i]));
      const rank = (n: TreeNode) => pos.get(nodeKey(n)) ?? -1;
      nodes.sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra === -1 && rb === -1) return spotify(a) - spotify(b) || collator.compare(name(a), name(b));
        if (ra === -1) return -1; // new items first, like Spotify
        if (rb === -1) return 1;
        return ra - rb;
      });
    }

    const ids: string[] = [];
    let max = -1;
    for (const n of nodes) {
      if (n.kind === "folder") ids.push(...n.playlistIds);
      else ids.push(n.playlist.id);
      max = Math.max(max, ts(n));
    }
    return { ids, ts: max };
  };
  finish(roots, null);
  return { roots, byId };
}

/**
 * Flattens the tree into visible rows. With a filter, a playlist shows if the query matches its
 * name plus its folder names; a matching folder shows everything inside it; collapse is ignored.
 */
export function flattenTree(nodes: TreeNode[], query: string, basePath: string[]): Row[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const matches = (text: string) => terms.every((t) => text.includes(t));
  const out: Row[] = [];

  const walk = (list: TreeNode[], depth: number, path: string, filtering: boolean, into: Row[]) => {
    for (const n of list) {
      if (n.kind === "playlist") {
        if (!filtering || matches(`${path} ${normalize(n.playlist.name)}`)) into.push({ node: n, depth });
        continue;
      }
      const fPath = `${path} ${normalize(n.folder.name)}`;
      if (!filtering) {
        into.push({ node: n, depth });
        if (!n.folder.collapsed || terms.length) walk(n.children, depth + 1, fPath, false, into);
        continue;
      }
      const selfMatch = matches(fPath);
      const childRows: Row[] = [];
      walk(n.children, depth + 1, fPath, !selfMatch, childRows);
      if (selfMatch || childRows.length) into.push({ node: n, depth }, ...childRows);
    }
  };

  walk(nodes, 0, basePath.map(normalize).join(" "), terms.length > 0, out);
  return out;
}
