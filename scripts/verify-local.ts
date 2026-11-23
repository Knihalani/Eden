// `bun run verify:local` — smoke-test the native eden-local binary in dist/local/ (A1).
// Spawns it with a token, expects EDEN_LOCAL_READY, then a 200/401 pair on /v1/whoami.

import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const osName = process.platform === "win32" ? "windows" : process.platform;
const bin = join(root, "dist", "local", `eden-local-${osName}-${process.arch}${osName === "windows" ? ".exe" : ""}`);
if (!existsSync(bin)) throw new Error(`${bin} not built — run \`bun run build:local\` first`);

// A random token: a fixed one would hand every process on the machine the daemon's credential.
const token = `local_${randomBytes(24).toString("hex")}`;
const child = Bun.spawn([bin], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, EDEN_LOCAL: "1", EDEN_LOCAL_TOKEN: token },
});
try {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read().then((r) => new TextDecoder().decode(r.value)),
    Bun.sleep(20000).then(() => {
      throw new Error("ready timeout");
    }),
  ]);
  if (!/^EDEN_LOCAL_READY [0-9]+/.test(first)) throw new Error(`unexpected first line: ${first}`);
  const base = `http://127.0.0.1:${first.trim().split(" ")[1]}`;
  const post = (auth: string) =>
    fetch(base + "/v1/whoami", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "local", userId: "u1", sessionId: "s1" }),
    });
  if ((await post("")).status !== 401 || (await post(token)).status !== 200) {
    throw new Error("auth check failed");
  }
  (child.stdin as import("bun").FileSink).end();
  if ((await child.exited) !== 0) throw new Error("did not exit 0 on stdin EOF");
  console.log(`verified ${bin}`);
} finally {
  child.kill();
}
