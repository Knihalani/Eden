/**
 * The native JSON read (D1860) against hostile HTTP framing, from a raw TCP server through the runtime's own `fetch`.
 * A JSON reply is read natively only when its length is one declared `Content-Length` under the cap, with no
 * `Content-Encoding` and no `Transfer-Encoding`; every other framing takes the capped stream read. These are the cases
 * D1840 found the native read unsafe on (a gzip body inflated far past its declared length; a chunked body read past
 * a `Content-Length` sent beside it, and until the deadline when short), plus a body longer or shorter than declared.
 */
import { afterEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { StreamableHttpTransport } from "./http";
import type { JsonRpcMessage } from "./types";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A server that answers every request with `raw(head, id)`'s bytes, or leaves the socket open when it returns null. */
async function raw(answer: (id: number) => Buffer | null): Promise<URL> {
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    let seen = "";
    sock.on("data", (d) => {
      seen += d.toString("latin1");
      const end = seen.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/content-length: *(\d+)/i.exec(seen.slice(0, end))?.[1] ?? 0);
      if (seen.length < end + 4 + length) return;
      const body = JSON.parse(seen.slice(end + 4, end + 4 + length)) as { id?: number };
      seen = "";
      const out = answer(body.id ?? -1);
      if (out) sock.write(out);
    });
  });
  const close = server.close.bind(server);
  server.close = ((cb?: () => void) => {
    for (const s of sockets) s.destroy();
    return close(cb);
  }) as typeof server.close;
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
}

const head = (lines: string[]) => `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n${lines.join("\r\n")}\r\n\r\n`;
const answer = (id: number, text: string) =>
  JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });

/** Sends request 1 and returns what came of it: the text it carried, or the error's message. */
async function call(url: URL, options: { maxResponseBytes?: number; timeoutMs?: number } = {}): Promise<string> {
  const t = new StreamableHttpTransport(url, options);
  let got = "";
  t.onmessage = (m: JsonRpcMessage) => {
    if ("result" in m) got = (m.result.content as { text: string }[])[0]!.text;
  };
  await t.start();
  try {
    await t.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } });
    return got;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await t.close();
  }
}

test("a declared length under the cap is read natively, and only that length", async () => {
  const url = await raw((id) => {
    const body = answer(id, 'ünï 😀 "q"');
    return Buffer.from(head([`content-length: ${Buffer.byteLength(body)}`]) + body + "garbage after the body");
  });
  expect(await call(url)).toBe('ünï 😀 "q"');
});

test("a declared length over the cap is refused before the body is read", async () => {
  const url = await raw((id) => {
    const body = answer(id, "x".repeat(2_000));
    return Buffer.from(head([`content-length: ${body.length}`]) + body);
  });
  expect(await call(url, { maxResponseBytes: 1_000 })).toMatch(/larger than 1000 bytes/);
});

test("a gzip body is capped after it is inflated, whatever length it declares (8 KB declared, 8 MB inside)", async () => {
  const url = await raw((id) => {
    const zipped = gzipSync(Buffer.from(answer(id, "y".repeat(8 * 1024 * 1024))));
    expect(zipped.length).toBeLessThan(64 * 1024);
    return Buffer.concat([Buffer.from(head([`content-length: ${zipped.length}`, "content-encoding: gzip"])), zipped]);
  });
  expect(await call(url, { maxResponseBytes: 1024 * 1024 })).toMatch(/larger than 1048576 bytes/);
});

test("a gzip body under the cap still reads (the stream read inflates it)", async () => {
  const url = await raw((id) => {
    const zipped = gzipSync(Buffer.from(answer(id, "small")));
    return Buffer.concat([Buffer.from(head([`content-length: ${zipped.length}`, "content-encoding: gzip"])), zipped]);
  });
  expect(await call(url)).toBe("small");
});

test("a chunked body with a small Content-Length beside it is capped by the stream read", async () => {
  const url = await raw((id) => {
    const body = answer(id, "z".repeat(1024 * 1024));
    const size = Buffer.byteLength(body).toString(16);
    return Buffer.from(head(["content-length: 10", "transfer-encoding: chunked"]) + `${size}\r\n${body}\r\n0\r\n\r\n`);
  });
  const got = await call(url, { maxResponseBytes: 64 * 1024, timeoutMs: 5_000 });
  // Bun reads the chunked body (and is capped); a runtime that refuses the framing fails the call: never read whole.
  expect(got).not.toBe("z".repeat(1024 * 1024));
  expect(got.length).toBeLessThan(200);
});

test("a body shorter than declared ends at the POST's deadline, not later", async () => {
  const url = await raw(() => Buffer.from(head(["content-length: 1000"]) + '{"jsonrpc":"2.0",'));
  const t0 = performance.now();
  expect(await call(url, { timeoutMs: 300 })).toMatch(/timed out/);
  expect(performance.now() - t0).toBeLessThan(3_000);
});

test("two Content-Length values, or one that is not a plain number, are not trusted", async () => {
  for (const length of ["10, 20", "+10", "1e1"]) {
    const url = await raw((id) => Buffer.from(head([`content-length: ${length}`]) + answer(id, "w".repeat(5_000))));
    const got = await call(url, { maxResponseBytes: 1_000, timeoutMs: 2_000 });
    expect(got).not.toBe("w".repeat(5_000));
  }
});

test("a reply shaped to make the parse costly is refused on the native read too", async () => {
  const url = await raw((id) => {
    const body = `{"jsonrpc":"2.0","id":${id},"result":{"a":${"[".repeat(1_100)}${"]".repeat(1_100)}}}`;
    return Buffer.from(head([`content-length: ${body.length}`]) + body);
  });
  expect(await call(url)).toMatch(/not JSON/);
});
