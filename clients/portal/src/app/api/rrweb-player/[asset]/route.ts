import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Serves rrweb-player UMD + CSS for the F09 sandboxed replay iframe.
 * Opaque-origin iframes (sandbox without parent-origin access) cannot use the
 * parent bundle; they load these same-origin static assets instead.
 */
const ALLOWED = {
  "rrweb-player.umd.min.cjs": {
    file: "rrweb-player.umd.min.cjs",
    type: "application/javascript; charset=utf-8",
  },
  "style.css": {
    file: "style.css",
    type: "text/css; charset=utf-8",
  },
} as const;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ asset: string }> },
) {
  const { asset } = await ctx.params;
  const meta = ALLOWED[asset as keyof typeof ALLOWED];
  if (!meta) {
    return new Response("Not found", { status: 404 });
  }
  const path = join(process.cwd(), "node_modules/rrweb-player/dist", meta.file);
  try {
    const body = await readFile(path);
    return new Response(body, {
      headers: {
        "Content-Type": meta.type,
        "Cache-Control": "public, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
