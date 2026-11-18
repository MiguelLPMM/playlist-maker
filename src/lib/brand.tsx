// App mark (green circle with a ringed plus), shared by the generated icons and preview image.
// Mirrors src/app/icon.svg — keep the two in sync.

export const BRAND = {
  name: "Playlist Maker",
  description: "Load all your Spotify liked songs, multi-select them, and turn them into playlists in one click.",
  green: "#1ed760",
  dark: "#121212",
};

export function BrandMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="32" fill={BRAND.green} />
      <circle cx="32" cy="32" r="20.65" fill="none" stroke="#000" strokeWidth="3.3" />
      <path d="M32 22.5v19M22.5 32h19" stroke="#000" strokeWidth="4.4" strokeLinecap="round" />
    </svg>
  );
}
