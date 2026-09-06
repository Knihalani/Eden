/**
 * Published pack on Impossible Cloud (S3 API). aws CLI only.
 * Fetch-before-merge, If-Match / If-None-Match put of one object (`graph.kpk`).
 * Credentials from env. Never log secrets.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allFacts, decodePack, encodePack, mergeFactLists, type PackFact } from "./pack";
import type { KnowStore } from "./store";
import { compactLeader, shardIndex } from "./defaults";

export const S3_ENDPOINT = "https://us-east-1.storage.impossibleapi.net";
export const S3_REGION = "us-east-1";
export const S3_BUCKET_DEFAULT = "eden-know";
export const S3_KEY_DEFAULT = "graph.kpk";

export function s3Bucket(): string {
  return process.env.EDEN_KNOW_S3_BUCKET || S3_BUCKET_DEFAULT;
}

export function s3Key(): string {
  return process.env.EDEN_KNOW_S3_KEY || S3_KEY_DEFAULT;
}

export function s3Endpoint(): string {
  return process.env.EDEN_KNOW_S3_ENDPOINT || S3_ENDPOINT;
}

export function s3Region(): string {
  return process.env.EDEN_KNOW_S3_REGION || S3_REGION;
}

/** Virtual-hosted public URL. Path-style is the S3 API, not the open dump. */
export function s3PublicUrl(bucket = s3Bucket(), key = s3Key()): string {
  const host = new URL(s3Endpoint()).host;
  return `https://${bucket}.${host}/${key}`;
}

/** Anonymous download of the current freeze. Impossible Cloud has no public GetObject. */
export const PUBLIC_DUMP_URL = "https://raw.githubusercontent.com/KaiavN/eden-know-data/main/graph.kpk";

export function s3Configured(): boolean {
  if (process.env.EDEN_KNOW_S3 === "0") return false;
  const id = process.env.EDEN_KNOW_S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.EDEN_KNOW_S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  return Boolean(id && secret);
}

function awsEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_DEFAULT_REGION: s3Region(),
    AWS_EC2_METADATA_DISABLED: "true",
  };
  if (process.env.EDEN_KNOW_S3_ACCESS_KEY) env.AWS_ACCESS_KEY_ID = process.env.EDEN_KNOW_S3_ACCESS_KEY;
  if (process.env.EDEN_KNOW_S3_SECRET_KEY) env.AWS_SECRET_ACCESS_KEY = process.env.EDEN_KNOW_S3_SECRET_KEY;
  return env;
}

function aws(args: string[], timeoutMs = 60_000): { status: number; stdout: string; stderr: string } {
  const bin = process.env.EDEN_KNOW_AWS_BIN || "aws";
  const r = spawnSync(bin, args, {
    env: awsEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16_000_000,
  });
  const status = r.status ?? (r.error ? 1 : 0);
  return { status, stdout: r.stdout || "", stderr: r.stderr || String(r.error || "") };
}

function commonArgs(): string[] {
  return ["--endpoint-url", s3Endpoint(), "--region", s3Region()];
}

export type RemotePack = { bytes: Uint8Array; etag: string };

function stripEtag(raw: string): string {
  return raw.trim().replace(/^"+|"+$/g, "");
}

export function fetchRemotePack(): RemotePack | null {
  const head = aws([
    "s3api",
    "head-object",
    "--bucket",
    s3Bucket(),
    "--key",
    s3Key(),
    ...commonArgs(),
  ]);
  const err = `${head.stdout} ${head.stderr}`;
  if (head.status !== 0 && /Not Found|404|NoSuchKey/i.test(err)) return null;
  if (head.status !== 0) throw new Error(`s3 head: ${head.stderr.slice(0, 200)}`);
  let etag = "";
  try {
    etag = stripEtag(JSON.parse(head.stdout).ETag || "");
  } catch {
    etag = "";
  }
  const dir = mkdtempSync(join(tmpdir(), "eden-know-s3-"));
  const dest = join(dir, "graph.kpk");
  try {
    const got = aws([
      "s3api",
      "get-object",
      "--bucket",
      s3Bucket(),
      "--key",
      s3Key(),
      ...commonArgs(),
      dest,
    ]);
    if (got.status !== 0) throw new Error(`s3 get: ${got.stderr.slice(0, 200)}`);
    const bytes = new Uint8Array(readFileSync(dest));
    if (!etag) {
      try {
        etag = stripEtag(JSON.parse(got.stdout).ETag || "");
      } catch {
        etag = "";
      }
    }
    return { bytes, etag };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function putRemotePack(
  bytes: Uint8Array,
  etag: string | null,
  key = s3Key(),
): { ok: true; etag: string } | { ok: false; conflict: boolean; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "eden-know-s3put-"));
  const src = join(dir, "graph.kpk");
  try {
    writeFileSync(src, bytes);
    const cond = key.startsWith("overlay/")
      ? []
      : etag
        ? ["--if-match", etag]
        : ["--if-none-match", "*"];
    const put = aws([
      "s3api",
      "put-object",
      "--bucket",
      s3Bucket(),
      "--key",
      key,
      "--body",
      src,
      "--content-type",
      "application/octet-stream",
      ...cond,
      ...commonArgs(),
    ]);
    const blob = `${put.stdout} ${put.stderr}`;
    if (put.status !== 0 && /Precondition|412|IfMatch|IfNoneMatch/i.test(blob)) {
      return { ok: false, conflict: true, err: "precondition" };
    }
    if (put.status !== 0) return { ok: false, conflict: false, err: put.stderr.slice(0, 200) };
    let next = "";
    try {
      next = stripEtag(JSON.parse(put.stdout).ETag || "");
    } catch {
      next = "";
    }
    return { ok: true, etag: next };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function overlayKey(shard = shardIndex()): string {
  return `overlay/${shard}/graph.kpk`;
}

export function overlayPrefix(): string {
  return "overlay/";
}

function listRemoteKeys(prefix: string): string[] {
  const listed = aws([
    "s3api",
    "list-objects-v2",
    "--bucket",
    s3Bucket(),
    "--prefix",
    prefix,
    ...commonArgs(),
  ]);
  if (listed.status !== 0) return [];
  try {
    const j = JSON.parse(listed.stdout) as { Contents?: { Key?: string }[] };
    return (j.Contents || []).map((c) => c.Key).filter((k): k is string => !!k);
  } catch {
    return [];
  }
}

function fetchRemoteObject(key: string): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "eden-know-s3ov-"));
  const dest = join(dir, "obj");
  try {
    const got = aws([
      "s3api",
      "get-object",
      "--bucket",
      s3Bucket(),
      "--key",
      key,
      ...commonArgs(),
      dest,
    ]);
    if (got.status !== 0) return null;
    return new Uint8Array(readFileSync(dest));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Follower overlay packs (not the published graph.kpk). */
export function fetchRemoteOverlays(): PackFact[] {
  const keys = listRemoteKeys(overlayPrefix()).filter((k) => k !== s3Key() && k.endsWith("graph.kpk"));
  const facts: PackFact[] = [];
  for (const key of keys) {
    const bytes = fetchRemoteObject(key);
    if (!bytes?.byteLength) continue;
    try {
      facts.push(...allFacts(decodePack(bytes)));
    } catch {
      /* skip a bad shard blob */
    }
  }
  return facts;
}

function shipFollowerOverlay(store: KnowStore): PublishResult {
  const facts = store.walFacts();
  let uploaded = false;
  if (s3Configured() && facts.length) {
    const bytes = encodePack(facts);
    uploaded = putRemotePack(bytes, null, overlayKey()).ok;
  }
  const local = store.compact();
  return {
    compacted: true,
    uploaded: false,
    bytes: local?.byteLength ?? 0,
    skipped: uploaded ? "follower" : "follower-no-overlay",
  };
}

export type PublishResult = {
  compacted: boolean;
  uploaded: boolean;
  bytes: number;
  sha256?: string;
  etag?: string;
  url?: string;
  skipped?: string;
};

/**
 * Fetch published pack, merge over local pack + WAL, rewrite, upload.
 * Compact is a full in-RAM rewrite on the compact host (allFacts is merge-only).
 * Query/inject never call this. If S3 fetch fails, compact locally and do not upload
 * (never clobber a graph we did not merge).
 */
export async function compactAndPublish(store: KnowStore): Promise<PublishResult> {
  if (!compactLeader()) return shipFollowerOverlay(store);
  let remote: RemotePack | null = null;
  if (s3Configured()) {
    try {
      remote = fetchRemotePack();
    } catch (e) {
      store.compact();
      return { compacted: true, uploaded: false, bytes: 0, skipped: `fetch-failed:${String(e).slice(0, 80)}` };
    }
  }
  let base: PackFact[] = [];
  if (remote) {
    try {
      base = allFacts(decodePack(remote.bytes));
    } catch (e) {
      store.compact();
      return { compacted: true, uploaded: false, bytes: 0, skipped: `decode-failed:${String(e).slice(0, 80)}` };
    }
  }
  try {
    base = mergeFactLists(base, fetchRemoteOverlays());
  } catch {
    /* overlays are fail-open so a missing prefix cannot block compact */
  }
  let bytes = store.compact(base);
  if (!bytes) return { compacted: true, uploaded: false, bytes: 0, skipped: "empty" };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!s3Configured()) {
    return { compacted: true, uploaded: false, bytes: bytes.byteLength, sha256 };
  }
  let etag = remote?.etag || null;
  for (let i = 0; i < 4; i++) {
    const put = putRemotePack(bytes, etag);
    if (put.ok) {
      return {
        compacted: true,
        uploaded: true,
        bytes: bytes.byteLength,
        sha256,
        etag: put.etag,
        url: s3PublicUrl(),
      };
    }
    if (!put.conflict) {
      return { compacted: true, uploaded: false, bytes: bytes.byteLength, sha256, skipped: `put-failed:${put.err}` };
    }
    try {
      remote = fetchRemotePack();
    } catch (e) {
      return { compacted: true, uploaded: false, bytes: bytes.byteLength, sha256, skipped: `refetch-failed:${String(e).slice(0, 80)}` };
    }
    base = mergeFactLists(remote ? allFacts(decodePack(remote.bytes)) : [], fetchRemoteOverlays());
    const next = store.compact(base);
    if (next) bytes = next;
    etag = remote?.etag || null;
  }
  return { compacted: true, uploaded: false, bytes: bytes.byteLength, sha256, skipped: "conflict-retries" };
}
