// Minimal Spotify Web API client: PKCE auth + fetch wrapper. No SDK on purpose
// (the official SDK still targets endpoints removed in the Feb 2026 API changes).

const CLIENT_ID = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? "";
const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
export const API_BASE = "https://api.spotify.com/v1";

export const SCOPES = [
  "user-library-read",
  "playlist-modify-private",
  "playlist-modify-public",
  "playlist-read-private", // needed later for "add to existing playlist"
];

const TOKEN_KEY = "spotify_token";
const VERIFIER_KEY = "spotify_pkce_verifier";
const STATE_KEY = "spotify_pkce_state";

export type StoredToken = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  scope: string;
};

export function redirectUri(): string {
  return `${window.location.origin}/callback`;
}

// ---------- PKCE helpers ----------

function randomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
}

// ---------- Auth flow ----------

export async function beginLogin(): Promise<void> {
  if (!CLIENT_ID) throw new Error("NEXT_PUBLIC_SPOTIFY_CLIENT_ID is not set");
  const verifier = randomString(64);
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: base64url(await sha256(verifier)),
    redirect_uri: redirectUri(),
    state,
  });
  window.location.href = `${AUTH_URL}?${params}`;
}

/** Exchanges the ?code= from the callback for tokens. Returns the raw token response. */
export async function completeLogin(code: string, state: string | null): Promise<Record<string, unknown>> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (!verifier) throw new Error("Missing PKCE verifier (did the login start on a different origin?)");
  if (state !== expectedState) throw new Error("OAuth state mismatch");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(json)}`);

  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  saveToken(json);
  return json;
}

function saveToken(json: { access_token: string; refresh_token?: string; expires_in: number; scope?: string }) {
  const prev = loadToken();
  const token: StoredToken = {
    access_token: json.access_token,
    // Spotify may or may not rotate the refresh token; keep the old one if not returned.
    refresh_token: json.refresh_token ?? prev?.refresh_token ?? "",
    expires_at: Date.now() + json.expires_in * 1000,
    scope: json.scope ?? prev?.scope ?? "",
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
}

export function loadToken(): StoredToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredToken) : null;
  } catch {
    return null;
  }
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
}

async function refreshToken(): Promise<StoredToken> {
  const current = loadToken();
  if (!current?.refresh_token) throw new Error("Not logged in");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
      client_id: CLIENT_ID,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    logout();
    throw new Error(`Token refresh failed (${res.status}): ${JSON.stringify(json)}`);
  }
  saveToken(json);
  return loadToken()!;
}

async function validAccessToken(): Promise<string> {
  let token = loadToken();
  if (!token) throw new Error("Not logged in");
  if (Date.now() > token.expires_at - 60_000) token = await refreshToken();
  return token.access_token;
}

// ---------- API wrapper ----------

export type ApiResult<T = unknown> = { ok: boolean; status: number; data: T };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls the Web API. Never throws on HTTP errors: it returns status + parsed body
 * so smoke tests can show exactly what Spotify said. Handles 429 (Retry-After) and
 * one 401 refresh-and-retry.
 */
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  let refreshed = false;

  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${await validAccessToken()}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
      await sleep((Number.isFinite(retryAfter) ? retryAfter : 1) * 1000 + 250);
      continue;
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await refreshToken();
      continue;
    }

    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body, keep as text */
    }
    return { ok: res.ok, status: res.status, data: data as T };
  }
  throw new Error(`Gave up after repeated 429s on ${path}`);
}

// ---------- Dev-only debug logging (writes to ./debug/<name>.json via /api/debug) ----------

export async function saveDebug(name: string, data: unknown) {
  if (process.env.NODE_ENV !== "development") return;
  try {
    await fetch("/api/debug", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, data }),
    });
  } catch {
    /* ignore */
  }
}

/** Hides secrets so token responses can be logged safely. */
export function redactToken(json: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...json };
  for (const k of ["access_token", "refresh_token"]) {
    const v = out[k];
    if (typeof v === "string") out[k] = `${v.slice(0, 6)}… (${v.length} chars)`;
  }
  return out;
}
