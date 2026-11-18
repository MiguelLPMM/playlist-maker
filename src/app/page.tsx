"use client";

import { useCallback, useEffect, useState } from "react";
import { beginLogin, loadToken, logout } from "@/lib/spotify";
import Library from "@/components/Library";

export default function Home() {
  const [auth, setAuth] = useState<"unknown" | "out" | "in">("unknown");

  useEffect(() => {
    // Spotify only accepts 127.0.0.1 redirect URIs, and PKCE state is per-origin.
    if (window.location.hostname === "localhost") {
      window.location.replace(window.location.href.replace("localhost", "127.0.0.1"));
      return;
    }
    setAuth(loadToken() ? "in" : "out");
  }, []);

  const handleLogout = useCallback(() => {
    logout();
    setAuth("out");
  }, []);

  if (auth === "unknown") return <main />;

  if (auth === "out") {
    return (
      <main className="login">
        <h1>Playlist Maker</h1>
        <p className="muted">Pick songs from your Liked Songs and turn them into a playlist.</p>
        <button onClick={() => beginLogin()}>Log in with Spotify</button>
      </main>
    );
  }

  return <Library onLogout={handleLogout} />;
}
