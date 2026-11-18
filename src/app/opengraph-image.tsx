// Link-preview image (WhatsApp, Discord, X, etc.), generated at build time.
import { ImageResponse } from "next/og";
import { BRAND, BrandMark } from "@/lib/brand";

export const alt = `${BRAND.name}: multi-select your liked songs into playlists`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          gap: 64,
          padding: "0 96px",
          background: "linear-gradient(135deg, #1f3a2a 0%, #121212 55%, #000 100%)",
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", borderRadius: 999, boxShadow: "0 24px 64px rgba(0,0,0,0.6)" }}>
          <BrandMark size={260} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20, flex: 1 }}>
          <div style={{ fontSize: 84, fontWeight: 700, letterSpacing: -2 }}>{BRAND.name}</div>
          <div style={{ fontSize: 36, color: "#b3b3b3", lineHeight: 1.3 }}>
            Load all your liked songs, multi-select, and build playlists in one click.
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
            {["Sort & search", "Shift-select ranges", "Playlist folders"].map((t) => (
              <div
                key={t}
                style={{ display: "flex", whiteSpace: "nowrap", fontSize: 24, padding: "8px 20px", borderRadius: 999, background: "rgba(30,215,96,0.15)", color: BRAND.green }}
              >
                {t}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
