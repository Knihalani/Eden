import { afterAll, expect, test } from "bun:test";
import { S3BlobStore, storeConfig } from "./blob-store";
import { fakeS3 } from "./fixtures/fake-s3";

const s3 = fakeS3("eden-test");
afterAll(() => s3.stop());
const env = {
  EDEN_PERSIST_STORE: "s3://eden-test/frozen",
  EDEN_S3_ENDPOINT: s3.url,
  EDEN_S3_ACCESS_KEY_ID: "test-access-key",
  EDEN_S3_SECRET_ACCESS_KEY: "test-secret-key-0123456789",
};

test("EDEN_PERSIST_STORE is checked at startup, and no message shows a credential (D992)", () => {
  expect(storeConfig({})).toBeNull();
  const c = storeConfig(env)!;
  expect([c.buckets, c.prefix, c.region]).toEqual([["eden-test"], "frozen/", "auto"]);
  expect(storeConfig({ ...env, EDEN_PERSIST_STORE: "s3://eden-test" })!.prefix).toBe("frozen/");
  for (const bad of ["eden-test", "s3://", "http://x/y", "s3://A_B/x"]) {
    expect(() => storeConfig({ ...env, EDEN_PERSIST_STORE: bad })).toThrow(/EDEN_PERSIST_STORE must be/);
  }
  let message = "";
  try {
    storeConfig({ ...env, EDEN_S3_ACCESS_KEY_ID: "" });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("EDEN_S3_ACCESS_KEY_ID");
  expect(message).not.toContain("test-secret-key");
  expect(() => storeConfig({ ...env, EDEN_S3_ENDPOINT: "not a url" })).toThrow(/EDEN_S3_ENDPOINT/);
});

test("EDEN_PERSIST_STORE names several buckets, comma-separated; every prefix must be the same (S1-P4)", () => {
  const c = storeConfig({
    ...env,
    EDEN_PERSIST_STORE: "s3://eden-frozen-0/frozen, s3://eden-frozen-1/frozen/,s3://eden-frozen-2",
  })!;
  expect(c.buckets).toEqual(["eden-frozen-0", "eden-frozen-1", "eden-frozen-2"]);
  expect(c.prefix).toBe("frozen/");
  expect(() => storeConfig({ ...env, EDEN_PERSIST_STORE: "s3://a-bucket/frozen,s3://b-bucket/other/" })).toThrow(
    /prefix/,
  );
  expect(() => storeConfig({ ...env, EDEN_PERSIST_STORE: "s3://a-bucket/frozen,nope" })).toThrow(
    /EDEN_PERSIST_STORE must be/,
  );
});

test("S3BlobStore puts, gets, lists page by page and deletes through Bun's S3 client; a missing key is null", async () => {
  const store = new S3BlobStore({ ...storeConfig(env)!, bucket: "eden-test" });
  const bytes = new Uint8Array([1, 2, 3, 250]);
  await store.put("frozen/0001-a.blob", bytes);
  expect(s3.objects.get("frozen/0001-a.blob")?.bytes).toEqual(bytes);
  expect(await store.get("frozen/0001-a.blob")).toEqual(bytes);
  expect(await store.get("frozen/nope.blob")).toBeNull();
  for (let i = 0; i < 1_005; i++) s3.objects.set(`frozen/x${String(i).padStart(4, "0")}`, { bytes, modified: 5_000 });
  s3.objects.set("other/y", { bytes, modified: 1 });
  const listed: string[] = [];
  for await (const o of store.list("frozen/")) listed.push(o.key);
  expect(listed.length).toBe(1_006); // two pages of ListObjectsV2
  expect(listed).not.toContain("other/y");
  await store.delete("frozen/0001-a.blob");
  await store.delete("frozen/never-there"); // a missing key is not an error
  expect(s3.objects.has("frozen/0001-a.blob")).toBe(false);
  s3.down = true;
  expect(store.get("frozen/x0001")).rejects.toBeDefined();
  s3.down = false;
});
