/**
 * The stdio client transport (D1860): spawns an MCP server as a child process and speaks newline-delimited JSON-RPC
 * over its stdin and stdout, as the spec's stdio transport does. Eden does not use it (its connectors are remote), so
 * it lives outside `index.ts` and is loaded only by a program that imports it.
 *
 * Bounded as the HTTP transport is, since the server is still a program the caller does not control:
 * - a line is read up to `maxLineBytes` (16 MiB by default, the HTTP reply cap); a longer one is dropped whole, up to
 *   its newline, never buffered;
 * - each line passes the shape check before `JSON.parse` (`parseJsonBytes`) and `asMessage` after it; a line that is
 *   neither is dropped, and at most 100 are reported to `onerror` (a flood of junk lines costs no more than reading);
 * - the server's requests go to the client, which answers `ping` only, at most 16 at once;
 * - `close` ends stdin, then sends SIGTERM after 2 s and SIGKILL 2 s later, so a server that ignores the end of its
 *   input cannot outlive its client;
 * - the child gets only the environment it is given, plus a few variables a program needs to start (`HOME`, `PATH`,
 *   ...): the parent's secrets are not passed on unless named. No shell is used.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { MAX_RESPONSE_BYTES } from "./http";
import { parseJsonBytes } from "./json";
import { asMessage, type JsonRpcMessage, type Transport } from "./types";

export interface StdioServerParameters {
  /** The program to run, found on `PATH`; no shell. */
  command: string;
  args?: string[];
  /** The child's environment, over the inherited defaults (`DEFAULT_INHERITED_ENV`). */
  env?: Record<string, string>;
  cwd?: string;
  /** The child's stderr: shown on ours ("inherit", the default) or discarded. */
  stderr?: "inherit" | "ignore";
  /** Longest line read from the server, in bytes (default `MAX_RESPONSE_BYTES`, 16 MiB). */
  maxLineBytes?: number;
  /** How long `close` waits for the server to exit after its stdin ends, and again after SIGTERM (default 2 s). */
  exitGraceMs?: number;
}

/** The parent's variables a child gets without being given them: enough to find programs and a home directory. */
export const DEFAULT_INHERITED_ENV =
  process.platform === "win32"
    ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE"].concat([
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
        "PROGRAMFILES",
      ])
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

/** Lines that were not JSON-RPC reported to `onerror`, at most; the rest are dropped unreported. */
const MAX_BAD_REPORTED = 100;
/** How long `close` waits for the server to exit after its stdin ends, and again after SIGTERM. */
const EXIT_GRACE_MS = 2_000;
const LF = 0x0a;

export class StdioClientTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private child: ChildProcess | null = null;
  private state: "new" | "open" | "closed" = "new";
  private readonly maxLine: number;
  /** The parts of a line not yet ended, and their bytes. */
  private parts: Uint8Array[] = [];
  private held = 0;
  /** The current line passed the cap: its bytes are skipped up to its newline. */
  private skipping = false;
  private bad = 0;
  /** Sends waiting for the pipe to drain; released when it does or the transport closes. */
  private readonly waiting = new Set<() => void>();
  private exited: Promise<void> = Promise.resolve();

  constructor(private readonly params: StdioServerParameters) {
    this.maxLine = params.maxLineBytes ?? MAX_RESPONSE_BYTES;
  }

  /** The child's process id once started. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<void> {
    if (this.state !== "new") return Promise.reject(new Error("StdioClientTransport already started"));
    this.state = "open";
    const env: Record<string, string> = {};
    for (const k of DEFAULT_INHERITED_ENV) {
      const v = process.env[k];
      // A value that is a shell function (`() {`) is never passed on, as the SDK does.
      if (v !== undefined && !v.startsWith("()")) env[k] = v;
    }
    Object.assign(env, this.params.env);
    return new Promise((resolve, reject) => {
      const child = spawn(this.params.command, this.params.args ?? [], {
        env,
        cwd: this.params.cwd,
        stdio: ["pipe", "pipe", this.params.stderr ?? "inherit"],
        shell: false,
        windowsHide: true,
      });
      this.child = child;
      this.exited = new Promise((done) => child.once("close", () => done()));
      child.once("spawn", () => resolve());
      child.once("error", (e) => {
        if (this.state === "open" && child.pid === undefined) reject(e);
        else this.onerror?.(e);
        void this.close();
      });
      child.once("close", () => void this.close());
      child.stdout!.on("data", this.onData);
      child.stdin!.on("error", (e: Error) => this.onerror?.(e));
      child.stdout!.on("error", (e: Error) => this.onerror?.(e));
    });
  }

  send(message: JsonRpcMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (this.state !== "open" || !stdin || stdin.destroyed) return reject(new Error("Not connected"));
      // Resolved once written or queued; a full pipe waits for `drain` (or the close), so a server that stops reading
      // holds back the sender instead of the process buffering without bound.
      if (stdin.write(`${JSON.stringify(message)}\n`)) return resolve();
      const done = () => {
        this.waiting.delete(done);
        stdin.off("drain", done);
        if (this.state === "open") resolve();
        else reject(new Error("Not connected"));
      };
      this.waiting.add(done);
      stdin.once("drain", done);
    });
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    for (const w of [...this.waiting]) w();
    const child = this.child;
    this.parts = [];
    this.held = 0;
    if (child) {
      child.stdout?.off("data", this.onData);
      child.stdin?.end();
      // A child that never started (no pid) has nothing to wait for.
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const grace = this.params.exitGraceMs ?? EXIT_GRACE_MS;
        const term = setTimeout(() => child.kill("SIGTERM"), grace);
        const kill = setTimeout(() => child.kill("SIGKILL"), 2 * grace);
        await this.exited;
        clearTimeout(term);
        clearTimeout(kill);
      }
    }
    this.onclose?.();
  }

  private readonly onData = (chunk: Uint8Array) => {
    let start = 0;
    for (let nl = chunk.indexOf(LF); nl >= 0; nl = chunk.indexOf(LF, start)) {
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      if (this.held + piece.length > this.maxLine) {
        this.drop();
        continue;
      }
      const line = this.parts.length > 0 ? join(this.parts, this.held, piece) : piece;
      this.parts = [];
      this.held = 0;
      this.line(line);
      if (this.state !== "open") return;
    }
    if (start < chunk.length && !this.skipping) {
      const rest = chunk.subarray(start);
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
    this.report(`a line passed ${this.maxLine} bytes and was dropped`);
  }

  private report(why: string): void {
    if (++this.bad <= MAX_BAD_REPORTED) this.onerror?.(new Error(`stdio: ${why}`));
  }

  private line(bytes: Uint8Array): void {
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === 0x0d) end--; // a CRLF server
    let blank = true;
    for (let i = 0; i < end && blank; i++) blank = bytes[i] === 0x20 || bytes[i] === 0x09;
    if (blank) return;
    const m = asMessage(parseJsonBytes(bytes.subarray(0, end)));
    if (m) this.onmessage?.(m);
    else this.report("a line that is not a JSON-RPC message was dropped");
  }
}

function join(parts: Uint8Array[], held: number, last: Uint8Array): Uint8Array {
  const out = new Uint8Array(held + last.length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  out.set(last, at);
  return out;
}
