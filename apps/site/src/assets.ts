import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILES: Record<string, { file: string; type: string }> = {
  "/logo.webp": { file: "logo.webp", type: "image/webp" },
  "/favicon.png": { file: "favicon.png", type: "image/png" },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png" },
};

const cache = new Map<string, Buffer>();

function dirs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(process.cwd(), "public"),
    join(process.cwd(), "apps/site/public"),
    join(here, "../public"),
    join(here, "../../public"),
  ];
}

/** Hosted wrap is a catch-all route, so public files must be served here. */
export async function servePublic(pathname: string): Promise<Response | null> {
  const spec = FILES[pathname];
  if (!spec) return null;
  let buf = cache.get(spec.file);
  if (!buf) {
    let lastErr: unknown;
    for (const dir of dirs()) {
      try {
        buf = await readFile(join(dir, spec.file));
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!buf) throw lastErr ?? new Error(`missing ${spec.file}`);
    cache.set(spec.file, buf);
  }
  return new Response(buf, {
    headers: {
      "content-type": spec.type,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

