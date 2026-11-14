// Frozen as D1704 shipped it (the D1840 bench and differential tests compare against it).
/**
 * MCP over stdio, the server's side (D1704): one JSON-RPC message per line on stdin, one per line on stdout. Lines
 * are cut from the bytes and decoded once each. A line past `MAX_LINE_BYTES` is dropped whole (up to its newline)
 * rather than buffered; a line that is not JSON, or is shaped to make the parse costly (`parseJsonBytes`), is
 * answered with a parse error (id null); a JSON value that is not a JSON-RPC message goes to the server, which
 * answers "Invalid Request". Stdout is the protocol channel: nothing else may write to it.
 */
import type { Readable, Writable } from "node:stream";
import { ErrorCode, type JsonRpcMessage, type Transport } from "@eden/sources";
import { parseJsonBytes } from "../../../sources/bench/mcp-d1704/json";

/**
 * Longest line read, in bytes. `ask_context` takes a question of at most 2,000 characters, so a request is a few KB;
 * 1 MiB leaves room for any client's envelope and bounds what a peer that never sends a newline can make us hold.
 */
export const MAX_LINE_BYTES = 1024 * 1024;
const LF = 0x0a;

export class StdioServerTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  /** Bytes of a line not yet ended (empty most of the time: a request rarely straddles chunks). */
  private parts: Buffer[] = [];
  private held = 0;
  /** The current line passed the cap: its bytes are skipped up to its newline. */
  private skipping = false;
  private started = false;
  private closed = false;

  constructor(
    private readonly stdin: Readable = process.stdin,
    private readonly stdout: Writable = process.stdout,
    private readonly maxLine = MAX_LINE_BYTES,
  ) {}

  private readonly onData = (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    let start = 0;
    for (let nl = buf.indexOf(LF); nl >= 0; nl = buf.indexOf(LF, start)) {
      const piece = buf.subarray(start, nl);
      start = nl + 1;
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      if (this.held + piece.length > this.maxLine) {
        this.drop();
        continue;
      }
      const line = this.parts.length ? Buffer.concat([...this.parts, piece]) : piece;
      this.parts = [];
      this.held = 0;
      this.line(line);
    }
    if (start < buf.length && !this.skipping) {
      const rest = buf.subarray(start);
      if (this.held + rest.length > this.maxLine) {
        this.drop();
        this.skipping = true;
      } else {
        this.parts.push(rest);
        this.held += rest.length;
      }
    }
  };

  private drop(): void {
    this.parts = [];
    this.held = 0;
    this.onerror?.(new Error(`stdio: a line passed ${this.maxLine} bytes and was dropped`));
  }

  private readonly onStreamError = (e: Error) => this.onerror?.(e);

  private line(bytes: Uint8Array): void {
    // A trailing CR (a CRLF peer) and blank lines are not messages.
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === 0x0d) end--;
    let blank = true;
    for (let i = 0; i < end && blank; i++) blank = bytes[i] === 0x20 || bytes[i] === 0x09;
    if (blank) return;
    const parsed = parseJsonBytes(bytes.subarray(0, end));
    if (parsed === undefined) {
      const error = { code: ErrorCode.ParseError, message: "Parse error" };
      // JSON-RPC's id for a message whose id could not be read is null.
      void this.send({ jsonrpc: "2.0", id: null as never, error }).catch(() => {});
      return;
    }
    this.onmessage?.(parsed as JsonRpcMessage);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("StdioServerTransport already started");
    this.started = true;
    this.stdin.on("data", this.onData);
    this.stdin.on("error", this.onStreamError);
  }

  send(message: JsonRpcMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("Not connected"));
      // Resolved once written or queued; a full pipe waits for `drain`, so a slow reader holds back the writer.
      const ok = this.stdout.write(`${JSON.stringify(message)}\n`, (e) => (e ? reject(e) : undefined));
      if (ok) resolve();
      else this.stdout.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stdin.off("data", this.onData);
    this.stdin.off("error", this.onStreamError);
    // Paused only if nothing else reads it, so the process can exit once the client is done.
    if (this.stdin.listenerCount("data") === 0) this.stdin.pause();
    this.parts = [];
    this.held = 0;
    this.onclose?.();
  }
}
