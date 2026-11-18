// Dev-only: lets the browser dump raw API responses to ./debug/<name>.json
// so they can be inspected outside the browser. Disabled in production.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development") {
    return new Response("Not found", { status: 404 });
  }
  const { name, data } = (await req.json()) as { name: string; data: unknown };
  const safeName = String(name).replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
  const dir = path.join(process.cwd(), "debug");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${safeName}.json`), JSON.stringify(data, null, 2), "utf8");
  return Response.json({ saved: `debug/${safeName}.json` });
}
