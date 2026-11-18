// PNG icons for installing the app (Android / desktop), generated at build time from BrandMark.
// They include the black background so Android doesn't put the icon on a white tile.
//   icon-192.png / icon-512.png   "any" purpose: green circle on black
//   maskable-512.png              "maskable": smaller circle, so Android can crop to its own shape
import { ImageResponse } from "next/og";
import { BrandMark } from "@/lib/brand";

const ICONS: Record<string, { size: number; markScale: number }> = {
  "icon-192.png": { size: 192, markScale: 0.86 },
  "icon-512.png": { size: 512, markScale: 0.86 },
  "maskable-512.png": { size: 512, markScale: 0.72 }, // stays inside the 80% safe zone
};

export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(ICONS).map((file) => ({ file }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const icon = ICONS[file];
  if (!icon) return new Response("Not found", { status: 404 });
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#000" }}>
        <BrandMark size={Math.round(icon.size * icon.markScale)} />
      </div>
    ),
    { width: icon.size, height: icon.size },
  );
}
