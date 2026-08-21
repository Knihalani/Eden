import { createHash } from "node:crypto";

export const PRIVATE_NO_STORE = "private, no-store";
export const PRIVATE_NO_CACHE = "private, no-cache";
export const PUBLIC_HOUR = "public, s-maxage=3600, stale-while-revalidate=86400";
export const PUBLIC_ASSET = "public, max-age=86400, stale-while-revalidate=604800";

export function weakEtag(body: string): string {
  return `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 20)}"`;
}

export function noneMatch(req: Request, etag: string): boolean {
  const got = req.headers.get("if-none-match");
  if (!got) return false;
  return got.split(",").some((part) => part.trim() === etag);
}
