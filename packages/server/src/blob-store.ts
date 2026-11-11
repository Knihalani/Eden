/**
 * The object store behind `SharedFrozenDisk` (D992), on Bun's built-in S3 client: no new dependency. Any
 * S3-compatible service works: Cloudflare R2 (`EDEN_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`, region
 * "auto"), Hetzner or OVH object storage, AWS S3, MinIO. The bytes it holds are the persistence files, already
 * encrypted under the operator's key (D425): the store never sees content or ids.
 *
 *   EDEN_PERSIST_STORE        s3://<bucket>/<prefix>   (prefix optional, default "frozen/")
 *   EDEN_S3_ENDPOINT          the service's endpoint URL (unset: AWS for the region)
 *   EDEN_S3_REGION            default "auto"
 *   EDEN_S3_ACCESS_KEY_ID, EDEN_S3_SECRET_ACCESS_KEY   credentials scoped to that bucket (never logged)
 */
import { S3Client } from "bun";
import type { BlobStore } from "@eden/engine";

export interface StoreConfig {
  bucket: string;
  prefix: string;
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Reads EDEN_PERSIST_STORE and its credentials; null when unset. Messages never contain a credential. */
export function storeConfig(env: NodeJS.ProcessEnv): StoreConfig | null {
  const url = env.EDEN_PERSIST_STORE ?? "";
  if (url === "") return null;
  const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(url);
  if (!m) throw new Error("EDEN_PERSIST_STORE must be s3://<bucket>/<prefix>, e.g. s3://eden-frozen/frozen/");
  let prefix = m[2] ?? "frozen/";
  if (prefix !== "" && !prefix.endsWith("/")) prefix += "/";
  const accessKeyId = env.EDEN_S3_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.EDEN_S3_SECRET_ACCESS_KEY ?? "";
  if (accessKeyId === "" || secretAccessKey === "") {
    throw new Error("EDEN_PERSIST_STORE needs EDEN_S3_ACCESS_KEY_ID and EDEN_S3_SECRET_ACCESS_KEY");
  }
  const endpoint = env.EDEN_S3_ENDPOINT || undefined;
  if (endpoint !== undefined && !/^https?:\/\/[^\s/]+/.test(endpoint)) {
    throw new Error("EDEN_S3_ENDPOINT must be an http(s) URL");
  }
  return { bucket: m[1]!, prefix, endpoint, region: env.EDEN_S3_REGION || "auto", accessKeyId, secretAccessKey };
}

/** True for the client's "no such object" (a 404), which `get` answers as null rather than a failure. */
function missing(e: unknown): boolean {
  const x = e as { code?: string; name?: string; message?: string } | null;
  return (
    x?.code === "NoSuchKey" ||
    x?.code === "ERR_S3_MISSING_OBJECT" ||
    x?.name === "NoSuchKey" ||
    /NoSuchKey|404|not found/i.test(x?.message ?? "")
  );
}

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;

  constructor(c: StoreConfig) {
    this.client = new S3Client({
      bucket: c.bucket,
      endpoint: c.endpoint,
      region: c.region,
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
    });
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.client.write(key, bytes, { type: "application/octet-stream" });
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await this.client.file(key).bytes();
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.delete(key);
    } catch (e) {
      if (!missing(e)) throw e;
    }
  }

  async *list(prefix: string): AsyncIterable<{ key: string; modified: number }> {
    let token: string | undefined;
    for (;;) {
      const page = await this.client.list({ prefix, maxKeys: 1_000, continuationToken: token });
      for (const o of page.contents ?? []) {
        const modified = o.lastModified ? Date.parse(o.lastModified) : 0;
        yield { key: o.key, modified: Number.isFinite(modified) ? modified : 0 };
      }
      if (!page.isTruncated || !page.nextContinuationToken) return;
      token = page.nextContinuationToken;
    }
  }
}
