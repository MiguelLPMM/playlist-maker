# Playlist Maker

A small web app for building Spotify playlists from your **Liked Songs**, fast.

Spotify's own apps make adding many liked songs to a playlist slow. This app loads all your liked songs into one long list, lets you select many at once, and adds them to a new or existing playlist in one click.

## Features

- **Everything in one list.** All liked songs load into a single scrolling list that stays smooth with thousands of songs. They're cached in the browser, so later visits only fetch what's new.
- **Fast selection.** Click to select, Shift+click for a range, Ctrl/Cmd+A to select everything shown, Esc to clear.
- **Sort and search.** Sort by title, artist, album, release date, date added or length. Shift+click a column header for a secondary sort. Search matches title, artist and album, ignoring accents.
- **Pick your columns.** Long-press or right-click the list header to choose columns. Choices are remembered separately for phone, tablet and desktop widths.
- **Add to playlists.** Create a new playlist, or add to existing ones. Songs already in a playlist are skipped.
- **Target playlists.** Tick playlists in the side panel (☰), and the main button becomes "Add to *X*" or "Add to N playlists".
- **Playlist folders.** Drag one playlist onto another to make a folder, drag to reorder, and double-click a folder to open it. Spotify's API doesn't share your real folders, so these are kept in the browser. Use **Export folders** / **Import folders** to back them up or move them to another browser.

## Setup

You need **Node.js 20+** and a **Spotify Premium** account. Premium is required to own an app in Spotify's Development Mode.

### 1. Create a Spotify app

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and click **Create app**.
2. Add the redirect URI `http://127.0.0.1:3000/callback`. It must be `127.0.0.1`, because Spotify doesn't accept `localhost`.
3. Under "Which API/SDKs", tick **Web API**, then save.
4. In **Settings → User Management**, add the Spotify account email of everyone who will use the app. Development Mode allows up to 5 users.
5. Copy the **Client ID**. The Client Secret isn't needed, because the app logs in with PKCE.

### 2. Run it locally

```bash
npm install
cp .env.example .env.local   # then paste your Client ID into .env.local
npm run dev
```

Open **http://127.0.0.1:3000**. If you open `localhost`, the app redirects you to `127.0.0.1`.

### 3. Deploy to Vercel

1. Import the repository into [Vercel](https://vercel.com/new).
2. Add the environment variable `NEXT_PUBLIC_SPOTIFY_CLIENT_ID`.
3. After the first deploy, add `https://<your-domain>/callback` as another redirect URI in the Spotify dashboard.

Saved songs, folders and settings are stored per website address. A new address starts empty, so export your folders first and import them on the new site.

## Spotify API notes (as of November 2026)

Spotify changed the Web API in February 2026, and many tutorials and libraries are now out of date. This app calls the REST API directly with `fetch`, without an SDK.

- **New endpoint names:** playlist endpoints use `/items` instead of `/tracks`. New playlists are created with `POST /me/playlists`.
- **Playlists are public:** Spotify ignores `public: false` when creating a playlist, and when changing it with `PUT /playlists/{id}`. New playlists are public; make them private in the Spotify app if needed.
- **No folders:** the Web API returns playlists as a flat list.
- **No "last modified" date:** "Recently updated" sorting uses the date the last song in each playlist was added.
- **Unavailable songs:** liked songs Spotify no longer serves come back with no title. They're kept in the cache so song counts match Spotify, but hidden from the list.
- **Scopes:** `user-library-read`, `playlist-read-private`, `playlist-modify-public`, `playlist-modify-private`.

## Project structure

```
src/
  app/
    page.tsx              login screen / app shell
    callback/page.tsx     OAuth callback (PKCE code exchange)
    api/debug/route.ts    dev only: saves raw API responses to ./debug for inspection
    icon.svg, apple-icon.tsx, opengraph-image.tsx, manifest.ts   icons and link previews
  components/
    Library.tsx           main screen: sync, selection, shortcuts, one-click add
    TrackList.tsx         virtualized song list, columns menu
    Sidebar.tsx           playlist panel: folders tree, drag and drop, targets
    AddToPlaylistDialog.tsx
  lib/
    spotify.ts            auth (PKCE), token refresh, fetch wrapper with 429 handling
    library.ts            liked-songs model, full and incremental sync, IndexedDB cache
    playlists.ts          playlist endpoints, duplicate-skipping adds
    folders.ts            folder model, ordering, tree building
    view.ts               search and sort
```

Built with Next.js, React and [TanStack Virtual](https://tanstack.com/virtual). Not affiliated with Spotify.
