import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PTC_CALLERS, type ToolRegistry, type ToolRunCtx } from "@eden/ir";
import { DeoptError } from "@eden/runtime";

const NETWORK_BINARIES = new Set(["curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "ftp"]);

function confined(cwd: string, p: string): string {
  const root = realpathSync(resolve(cwd));
  const target = resolve(root, p);
  let checked = target;
  try {
    if (existsSync(target)) checked = realpathSync(target);
    else {
      let dir = dirname(target);
      while (dir.length >= root.length) {
        if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
          checked = resolve(realpathSync(dir), relative(dir, target));
          break;
        }
        if (dir === root) break;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    throw new Error("path outside workspace");
  }
  const rel = relative(root, checked);
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith("..\\")) {
    throw new Error("path outside workspace");
  }
  if (!checked.startsWith(root + sep) && checked !== root) throw new Error("path outside workspace");
  return existsSync(target) ? checked : target;
}

export function codingRegistry(cwd = process.cwd()): ToolRegistry {
  const names = new Set([
    "Bash",
    "bash",
    "Read",
    "read",
    "Write",
    "write",
    "Edit",
    "edit",
    "LS",
    "ls",
    "Grep",
    "grep",
    "Glob",
    "glob",
  ]);
  return {
    has: (name) => names.has(name),
    allowed_callers: [...PTC_CALLERS],
    execute: async (name, args, ctx?: ToolRunCtx) => {
      if (ctx?.signal?.aborted) throw new DeoptError("aborted");
      if (name === "Bash" || name === "bash") {
        const cmd = String(args.command ?? "").trim();
        if (!cmd) throw new Error("empty command");
        if (/[`$]|\$\(|\$\{/.test(cmd)) throw new Error("path outside workspace");
        if (/[<>]\(/.test(cmd)) throw new Error("path outside workspace");
        if (/(^|[;&|\n]|&&|\|\|)\s*cd\s+['"]?(\.\.|\/|~)/.test(cmd) || /(^|[\s'"`])\.\.(\/|$)/.test(cmd)) {
          throw new Error("path outside workspace");
        }
        if (/(^|[\s;(])cd\s+['"]?(\.\.|\/|~)/.test(cmd)) {
          throw new Error("path outside workspace");
        }
        if (/(^|[\s;|&'"(])~[A-Za-z0-9_-]/.test(cmd)) {
          throw new Error("path outside workspace");
        }
        for (const m of cmd.matchAll(/(?:^|[\s;|&`'"(=]|(?:\d)?[<>])((?:~\/|~[A-Za-z0-9_-]+|\/)[^\s'"`;&|)]*)/g)) {
          const token = m[1]!;
          if (!token || token.includes("://")) continue;
          if (token === "/dev/null" || token.startsWith("/dev/fd")) continue;
          if (token.startsWith("~")) throw new Error("path outside workspace");
          confined(cwd, token);
        }
        const allow = new Set((process.env.EDEN_NET_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean));
        const segments = cmd.split(/\||&&/);
        for (let s = 1; s < segments.length; s++) {
          const words = segments[s]!.trim().split(/\s+/);
          let target = "";
          for (const w of words) {
            const base = w.split("/").pop()!.toLowerCase();
            if (base === "sudo" || base === "env" || base === "nohup" || base === "exec" || base === "command") continue;
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
            target = base;
            break;
          }
          if (NETWORK_BINARIES.has(target) && !allow.has(target)) {
            throw new Error(`network binary ${target} cannot receive a pipe`);
          }
        }
        const env = { ...process.env };
        for (const k of Object.keys(env)) {
          if (/key|token|secret|password|passwd|authorization/i.test(k)) {
            delete env[k];
            continue;
          }
          const v = env[k];
          if (typeof v === "string" && /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s@]+@/i.test(v)) delete env[k];
        }
        const proc = spawn(cmd, { cwd, shell: true, env });
        const chunks: Buffer[] = [];
        const err: Buffer[] = [];
        proc.stdout.on("data", (c) => chunks.push(c as Buffer));
        proc.stderr.on("data", (c) => err.push(c as Buffer));
        const requested = Number(args.timeout_ms);
        const ms = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 15_000, 60_000);
        const killer = setTimeout(() => proc.kill("SIGKILL"), ms);
        const onAbort = () => proc.kill("SIGKILL");
        ctx?.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const code: number = await new Promise((resolve) => proc.on("close", (c) => resolve(c ?? 1)));
          return { stdout: Buffer.concat(chunks).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), code };
        } finally {
          clearTimeout(killer);
          ctx?.signal?.removeEventListener("abort", onAbort);
        }
      }
      if (name === "Read" || name === "read") {
        const path = confined(cwd, String(args.path ?? args.file_path ?? ""));
        if (ctx?.signal?.aborted) throw new DeoptError("aborted");
        return { content: await readFile(path, { encoding: "utf8", signal: ctx?.signal }) };
      }
      if (name === "Write" || name === "write") {
        const path = confined(cwd, String(args.path ?? args.file_path ?? ""));
        if (ctx?.signal?.aborted) throw new DeoptError("aborted");
        const contents = String(args.contents ?? args.content ?? "");
        await writeFile(path, contents, { encoding: "utf8", signal: ctx?.signal });
        return { ok: true, path };
      }
      if (name === "Edit" || name === "edit") {
        const path = confined(cwd, String(args.path ?? args.file_path ?? ""));
        if (ctx?.signal?.aborted) throw new DeoptError("aborted");
        const old = String(args.old_string ?? args.oldString ?? "");
        const next = String(args.new_string ?? args.newString ?? args.contents ?? "");
        const cur = await readFile(path, { encoding: "utf8", signal: ctx?.signal });
        if (!old) throw new Error("old_string is required; use Write to replace a whole file");
        const at = cur.indexOf(old);
        if (at === -1) throw new Error("old_string not found");
        if (cur.indexOf(old, at + old.length) !== -1) {
          throw new Error("old_string is not unique; include more context");
        }
        const updated = cur.slice(0, at) + next + cur.slice(at + old.length);
        await writeFile(path, updated, { encoding: "utf8", signal: ctx?.signal });
        return { ok: true, path };
      }
      if (name === "LS" || name === "ls") {
        const path = confined(cwd, String(args.path ?? args.file_path ?? "."));
        if (ctx?.signal?.aborted) throw new DeoptError("aborted");
        const entries = await readdir(path, { withFileTypes: true });
        return { entries: entries.map((e) => ({ name: e.name, dir: e.isDirectory() })) };
      }
      if (name === "Grep" || name === "grep") {
        const pattern = String(args.pattern ?? args.query ?? "");
        if (!pattern) throw new Error("empty pattern");
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch {
          throw new Error("invalid pattern");
        }
        const root = confined(cwd, String(args.path ?? args.file_path ?? "."));
        const matches: Array<{ path: string; line: number; text: string }> = [];
        const MAX_DIRS = 500;
        let dirsVisited = 0;
        const walk = async (dir: string) => {
          if (ctx?.signal?.aborted) throw new DeoptError("aborted");
          if (matches.length >= 200) return;
          if (++dirsVisited > MAX_DIRS) return;
          const entries = await readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (matches.length >= 200) return;
            if (e.name.startsWith(".")) continue;
            const p = join(dir, e.name);
            if (e.isDirectory()) await walk(p);
            else if (e.isFile()) {
              const text = await readFile(p, { encoding: "utf8", signal: ctx?.signal }).catch(() => "");
              if (!text || text.includes("\0")) continue;
              const lines = text.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (re.test(lines[i]!)) {
                  matches.push({ path: relative(cwd, p), line: i + 1, text: lines[i]! });
                  if (matches.length >= 200) return;
                }
              }
            }
          }
        };
        const st = lstatSync(root);
        if (st.isFile()) {
          const text = await readFile(root, { encoding: "utf8", signal: ctx?.signal });
          text.split("\n").forEach((line, i) => {
            if (re.test(line)) matches.push({ path: relative(cwd, root), line: i + 1, text: line });
          });
        } else await walk(root);
        return { matches };
      }
      if (name === "Glob" || name === "glob") {
        const pattern = String(args.pattern ?? args.glob ?? "*");
        const root = confined(cwd, String(args.path ?? "."));
        const files: string[] = [];
        const g = new Bun.Glob(pattern);
        for await (const f of g.scan({ cwd: root, onlyFiles: true })) {
          confined(cwd, join(root, f));
          files.push(f);
          if (files.length >= 500) break;
        }
        return { files };
      }
      throw new Error(`unsupported coding tool ${name}`);
    },
  };
}
