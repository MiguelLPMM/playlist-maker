"use client";

import { useEffect, useRef, useState } from "react";
import { completeLogin, redactToken, saveDebug } from "@/lib/spotify";

export default function CallbackPage() {
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false); // React dev StrictMode runs effects twice; a code can only be exchanged once.

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const err = params.get("error");
    if (err) {
      setError(`Spotify returned error: ${err}`);
      return;
    }
    if (!code) {
      setError("No ?code= in the callback URL");
      return;
    }

    completeLogin(code, params.get("state"))
      .then(async (tokenJson) => {
        const redacted = redactToken(tokenJson);
        console.log("Token response (redacted):", redacted);
        await saveDebug("01_token_response", redacted);
        window.location.replace("/");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main>
      {error ? (
        <div className="card">
          <p className="bad">Login failed</p>
          <pre>{error}</pre>
          <a href="/">Back</a>
        </div>
      ) : (
        <p className="muted">Finishing login…</p>
      )}
    </main>
  );
}
