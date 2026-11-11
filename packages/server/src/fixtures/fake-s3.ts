/**
 * A minimal S3-compatible server for tests (D992): path-style PUT, GET, HEAD and DELETE of objects and ListObjectsV2,
 * in memory, signatures not checked. Enough for `S3BlobStore` through Bun's S3 client; the real-service check is the
 * MinIO run in docs/research/d1-scale-out.md. `down` answers every request 503.
 */
export interface FakeS3 {
  url: string;
  objects: Map<string, { bytes: Uint8Array; modified: number }>;
  requests: { method: string; key: string }[];
  down: boolean;
  stop(): void;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function fakeS3(bucket: string): FakeS3 {
  const objects = new Map<string, { bytes: Uint8Array; modified: number }>();
  const requests: { method: string; key: string }[] = [];
  const state = { down: false };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      if (!path.startsWith(`/${bucket}`)) return new Response("NoSuchBucket", { status: 404 });
      const key = path.slice(bucket.length + 2);
      requests.push({ method: req.method, key });
      if (state.down) return new Response("SlowDown", { status: 503 });
      if (req.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const max = Number(url.searchParams.get("max-keys") ?? 1000);
        const after = url.searchParams.get("continuation-token") ?? "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = keys.slice(0, max);
        const truncated = keys.length > page.length;
        const body =
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name>` +
          `<Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys>` +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${xml(page.at(-1)!)}</NextContinuationToken>` : "") +
          page
            .map((k) => {
              const o = objects.get(k)!;
              return (
                `<Contents><Key>${xml(k)}</Key><LastModified>${new Date(o.modified).toISOString()}</LastModified>` +
                `<Size>${o.bytes.byteLength}</Size><ETag>"x"</ETag></Contents>`
              );
            })
            .join("") +
          `</ListBucketResult>`;
        return new Response(body, { headers: { "content-type": "application/xml" } });
      }
      if (req.method === "PUT") {
        objects.set(key, { bytes: new Uint8Array(await req.arrayBuffer()), modified: Date.now() });
        return new Response(null, { status: 200, headers: { etag: '"x"' } });
      }
      const o = objects.get(key);
      if (req.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (!o) {
        const body = `<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>not found</Message></Error>`;
        return new Response(req.method === "HEAD" ? null : body, { status: 404 });
      }
      const headers = {
        "content-length": String(o.bytes.byteLength),
        "last-modified": new Date(o.modified).toUTCString(),
      };
      return new Response(req.method === "HEAD" ? null : o.bytes, { headers });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    objects,
    requests,
    get down() {
      return state.down;
    },
    set down(v: boolean) {
      state.down = v;
    },
    stop: () => void server.stop(true),
  };
}
