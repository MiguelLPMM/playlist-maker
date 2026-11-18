"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Track } from "@/lib/library";
import { normalize } from "@/lib/view";
import { addItems, createPlaylist, getPlaylistUris, type PlaylistSummary } from "@/lib/playlists";

type Props = {
  tracks: Track[]; // selected songs, in the order they'll be added
  playlists: PlaylistSummary[] | null; // editable playlists, loaded by the parent
  playlistsError: string | null;
  onCreated: (p: PlaylistSummary) => void;
  onAdded: (playlistId: string, added: number) => void;
  onClose: () => void;
  onClearSelection: () => void;
};

type Phase =
  | { kind: "form" }
  | { kind: "working"; step: string; added: number; total: number }
  | { kind: "done"; playlist: PlaylistSummary; added: number; skippedDupes: number; skippedLocal: number; created: boolean }
  | { kind: "error"; message: string; playlist: PlaylistSummary | null };

export default function AddToPlaylistDialog({ tracks, playlists, playlistsError, onCreated, onAdded, onClose, onClearSelection }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const createdRef = useRef<PlaylistSummary | null>(null); // so a retry after a failed add doesn't create a second playlist
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [skipDupes, setSkipDupes] = useState(true);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const [playlistFilter, setPlaylistFilter] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);

  const addable = useMemo(() => tracks.filter((t) => !t.isLocal), [tracks]);
  const localCount = tracks.length - addable.length;
  const working = phase.kind === "working";

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const filteredPlaylists = useMemo(() => {
    const q = normalize(playlistFilter.trim());
    return (playlists ?? []).filter((p) => !q || normalize(p.name).includes(q));
  }, [playlists, playlistFilter]);

  const canSubmit =
    !working && addable.length > 0 && (mode === "new" ? name.trim().length > 0 : targetId !== null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    let playlist: PlaylistSummary | null = null;
    try {
      let uris = addable.map((t) => t.uri);
      let skippedDupes = 0;

      if (mode === "new" && !createdRef.current) {
        setPhase({ kind: "working", step: "Creating playlist…", added: 0, total: uris.length });
        playlist = await createPlaylist(name.trim(), description.trim());
        createdRef.current = playlist;
        onCreated(playlist);
      } else {
        playlist = mode === "new" ? createdRef.current! : playlists!.find((p) => p.id === targetId)!;
        if (skipDupes || mode === "new") {
          setPhase({ kind: "working", step: "Checking what's already in the playlist…", added: 0, total: uris.length });
          const existing = await getPlaylistUris(playlist.id);
          const before = uris.length;
          uris = uris.filter((u) => !existing.has(u));
          skippedDupes = before - uris.length;
        }
      }

      const target = playlist;
      setPhase({ kind: "working", step: "Adding songs…", added: 0, total: uris.length });
      await addItems(target.id, uris, (added) =>
        setPhase({ kind: "working", step: "Adding songs…", added, total: uris.length }),
      );
      onAdded(target.id, uris.length);
      setPhase({
        kind: "done",
        playlist: target,
        added: uris.length,
        skippedDupes,
        skippedLocal: localCount,
        created: mode === "new",
      });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err), playlist });
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      onCancel={(e) => working && e.preventDefault() /* don't close mid-upload */}
      onClose={onClose}
    >
      {phase.kind === "done" ? (
        <div className="dialog-body">
          <h2>Done</h2>
          <p>
            {phase.created ? "Created" : "Updated"} <strong>{phase.playlist.name}</strong>: added{" "}
            {phase.added.toLocaleString()} song{phase.added === 1 ? "" : "s"}.
          </p>
          {phase.skippedDupes > 0 && <p className="muted">{phase.skippedDupes} were already in the playlist and were skipped.</p>}
          {phase.skippedLocal > 0 && <p className="muted">{phase.skippedLocal} local files were skipped (Spotify can't add those).</p>}
          <div className="dialog-actions">
            <a className="button-link" href={phase.playlist.url} target="_blank" rel="noreferrer">
              Open in Spotify
            </a>
            <div className="spacer" />
            <button
              className="secondary"
              onClick={() => {
                onClearSelection();
                dialogRef.current?.close();
              }}
            >
              Clear selection &amp; close
            </button>
            <button onClick={() => dialogRef.current?.close()}>Close</button>
          </div>
        </div>
      ) : (
        <form className="dialog-body" onSubmit={submit}>
          <h2>
            Add {addable.length.toLocaleString()} song{addable.length === 1 ? "" : "s"} to a playlist
          </h2>
          {localCount > 0 && <p className="muted">{localCount} local files in the selection will be skipped.</p>}

          <div className="segmented" role="tablist">
            <button type="button" role="tab" aria-selected={mode === "new"} className={mode === "new" ? "on" : ""} onClick={() => setMode("new")} disabled={working}>
              New playlist
            </button>
            <button type="button" role="tab" aria-selected={mode === "existing"} className={mode === "existing" ? "on" : ""} onClick={() => setMode("existing")} disabled={working}>
              Existing playlist
            </button>
          </div>

          {mode === "new" ? (
            <div className="fields">
              <label>
                Name
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="My new playlist" disabled={working} />
              </label>
              <label>
                Description <span className="muted">(optional)</span>
                <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} disabled={working} />
              </label>
              <p className="muted small-text">
                New playlists are public — Spotify&apos;s API currently ignores &quot;private&quot;. You can make it private in Spotify afterwards.
              </p>
            </div>
          ) : (
            <div className="fields">
              {playlistsError ? (
                <p className="bad">{playlistsError}</p>
              ) : !playlists ? (
                <p className="muted">Loading your playlists…</p>
              ) : (
                <>
                  <input
                    type="search"
                    placeholder={`Filter ${playlists.length} playlists`}
                    value={playlistFilter}
                    onChange={(e) => setPlaylistFilter(e.target.value)}
                    disabled={working}
                  />
                  <div className="playlist-picker" role="listbox" aria-label="Your playlists">
                    {filteredPlaylists.map((p) => (
                      <button
                        type="button"
                        key={p.id}
                        role="option"
                        aria-selected={targetId === p.id}
                        className={`playlist-option ${targetId === p.id ? "on" : ""}`}
                        onClick={() => setTargetId(p.id)}
                        disabled={working}
                      >
                        {p.image ? <img src={p.image} alt="" width={36} height={36} /> : <span className="cover-ph small" />}
                        <span className="ellipsis">{p.name}</span>
                        <span className="muted">{p.total ?? ""}</span>
                      </button>
                    ))}
                    {!filteredPlaylists.length && <p className="muted">No playlists match.</p>}
                  </div>
                  <label className="check-line">
                    <input type="checkbox" checked={skipDupes} onChange={(e) => setSkipDupes(e.target.checked)} disabled={working} />
                    Skip songs already in the playlist
                  </label>
                </>
              )}
            </div>
          )}

          {phase.kind === "working" && (
            <div className="progress-line">
              <span className="muted">
                {phase.step} {phase.total > 0 && `${phase.added.toLocaleString()} / ${phase.total.toLocaleString()}`}
              </span>
              <progress value={phase.added} max={Math.max(phase.total, 1)} />
            </div>
          )}

          {phase.kind === "error" && (
            <div className="error-box">
              <span className="bad">Something went wrong.</span>
              {phase.playlist && (
                <>
                  {" "}
                  The playlist{" "}
                  <a href={phase.playlist.url} target="_blank" rel="noreferrer">
                    {phase.playlist.name}
                  </a>{" "}
                  may be partially filled.
                </>
              )}
              <pre>{phase.message}</pre>
            </div>
          )}

          <div className="dialog-actions">
            <span className="muted small-text">Songs are added in the list&apos;s current order.</span>
            <div className="spacer" />
            <button type="button" className="secondary" onClick={() => dialogRef.current?.close()} disabled={working}>
              Cancel
            </button>
            <button type="submit" disabled={!canSubmit}>
              {working ? "Working…" : mode === "new" ? "Create playlist" : "Add songs"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
