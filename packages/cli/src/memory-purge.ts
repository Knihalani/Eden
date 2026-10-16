/**
 * `eden memory purge <regex>` and `eden memory forget --secret <regex>` (D13, A6 §2.2.4): the physical rewrite.
 *
 * - Every file under the memory root is rewritten without the matches, each replaced by `[REDACTED]`: in a JSON or
 *   JSON-lines file, inside its strings and keys, so every line still parses; in any other text file, in place. A
 *   postings snapshot (`postings.snap`, P4.2) is deleted instead, every one under the root, at every purge: it is
 *   derived from the store, holds its words lowercased, stemmed and split (so a pattern that matched a row need not
 *   match it), may still hold the words of a row the store has since dropped, its byte offsets would not survive a
 *   rewrite, and sleep builds it again from the purged rows. A
 *   SQLite store loses the rows that match, with `secure_delete`, a truncating WAL checkpoint and `VACUUM`, so no
 *   free page keeps them. A file is rewritten under its writers' lock (`<file>.lock`); other binary files are left
 *   as they are and named.
 * - The Claude Code transcripts that still hold a match (`$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`)
 *   are listed. Eden never edits them: the user decides.
 */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { REDACTED } from "@eden/ir";
import { SNAPSHOT_FILE } from "../../../src/memory-postings";
import { withFileLock, writeFileAtomic } from "./home";
import { memoryRoot } from "./memory-hook";

const SQLITE_HEADER = "SQLite format 3\0";
/** A SQLite store's companions: its checkpoint and VACUUM rewrite them. */
const SQLITE_COMPANION = /-(?:wal|shm|journal)$/;

interface Purged {
  matches: number;
  files: number;
  /** Files left as they were, and why: binary, or a read, lock or write that failed. */
  skipped: { path: string; why: string }[];
}

export function memoryPurgeHelp(): string {
  return `usage: eden memory purge <regex>
       eden memory forget --secret <regex>

Rewrites every file under the memory root without what <regex> matches, and lists
the Claude transcripts that still hold it (Eden never edits them).
`;
}

/** The pattern after `purge`, or after `forget --secret`; undefined when the arguments name none. */
function patternArg(args: readonly string[]): string | undefined {
  if (args[0] === "purge") return args[1];
  if (args[0] === "forget" && args[1] === "--secret") return args[2];
  return undefined;
}

export function memoryPurgeCli(args: readonly string[]): number {
  const source = patternArg(args);
  if (!source || source === "--help" || source === "-h") {
    console.log(memoryPurgeHelp());
    return source ? 0 : 2;
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, "g");
  } catch (err) {
    console.log(`purge: invalid pattern: ${(err as Error).message}`);
    return 2;
  }
  const root = memoryRoot();
  const purged = purgeTree(root, pattern);
  console.log(`purged ${purged.matches} matches in ${purged.files} files under ${root}`);
  for (const { path, why } of purged.skipped) console.log(`not rewritten (${why}): ${path}`);
  const transcripts = transcriptsHolding(pattern);
  if (!transcripts.length) console.log("no Claude transcript holds it");
  else {
    console.log("Claude transcripts that still hold it (Eden never edits them; edit or delete them yourself):");
    for (const path of transcripts) console.log(`  ${path}`);
  }
  // A file left as it was may still hold the match.
  return purged.skipped.length ? 1 : 0;
}

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}

function purgeTree(root: string, pattern: RegExp): Purged {
  const purged: Purged = { matches: 0, files: 0, skipped: [] };
  const files = filesUnder(root);
  const snapshots = files.filter((path) => basename(path) === SNAPSHOT_FILE);
  for (const path of files) {
    if (path.endsWith(".lock") || SQLITE_COMPANION.test(path) || snapshots.includes(path)) continue;
    try {
      const matches = purgeFile(path, pattern);
      purged.matches += matches;
      if (matches) purged.files++;
    } catch (err) {
      purged.skipped.push({ path, why: err instanceof BinaryFile ? "binary" : (err as Error).message });
    }
  }
  for (const path of snapshots) dropDerived(path, purged);
  return purged;
}

/** A derived index, deleted (see the header); a file that cannot be deleted is named, as a rewrite would be. */
function dropDerived(path: string, purged: Purged): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") purged.skipped.push({ path, why: (err as Error).message });
  }
}

class BinaryFile extends Error {}

/** One file without the matches; returns how many it removed. Throws when it cannot rewrite the file. */
function purgeFile(path: string, pattern: RegExp): number {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, SQLITE_HEADER.length).toString("latin1") === SQLITE_HEADER) return purgeSqlite(path, pattern);
  if (bytes.includes(0)) throw new BinaryFile();
  return withFileLock(`${path}.lock`, () => purgeText(path, pattern));
}

/** Rewrites a text file without the matches; returns how many it removed. */
function purgeText(path: string, pattern: RegExp): number {
  const text = readFileSync(path, "utf8");
  let count = 0;
  const scrub = (value: string) =>
    value.replace(pattern, () => {
      count++;
      return REDACTED;
    });
  const json = /\.jsonl?$|\.log$/.test(basename(path));
  const out = json
    ? text
        .split("\n")
        .map((line) => purgeLine(line, scrub))
        .join("\n")
    : scrub(text);
  if (count) writeFileAtomic(path, out, 0o600);
  return count;
}

/** A line of JSON with its strings and keys scrubbed, or the raw line scrubbed when it is not JSON. */
function purgeLine(line: string, scrub: (value: string) => string): string {
  if (!line.trim()) return line;
  try {
    return JSON.stringify(scrubValue(JSON.parse(line), scrub));
  } catch {
    return scrub(line);
  }
}

function scrubValue(value: unknown, scrub: (value: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, scrub));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrub(key), scrubValue(item, scrub)]));
  return value;
}

/**
 * Deletes every row with a matching text column, then lets no page keep it: `secure_delete` zeroes freed content,
 * the checkpoint empties the WAL, and `VACUUM` rebuilds the file. The tables behind a virtual table (FTS5's
 * `<name>_data` and the like) are left to it: deleting from the virtual table updates them.
 */
function purgeSqlite(path: string, pattern: RegExp): number {
  const db = new Database(path);
  try {
    db.run("PRAGMA secure_delete=ON");
    const tables = db
      .query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string; sql: string | null }[];
    const virtual = tables.filter((table) => /^CREATE VIRTUAL TABLE/i.test(table.sql ?? "")).map((t) => t.name);
    let deleted = 0;
    for (const { name } of tables) {
      if (virtual.some((owner) => name.startsWith(`${owner}_`))) continue;
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const rows = db.query(`SELECT rowid AS eden_rowid, * FROM ${quoted}`).all() as Record<string, unknown>[];
      const doomed = rows.filter((row) =>
        Object.entries(row).some(([key, value]) => key !== "eden_rowid" && matchesText(value, pattern)),
      );
      const remove = db.prepare(`DELETE FROM ${quoted} WHERE rowid = ?`);
      for (const row of doomed) remove.run(row.eden_rowid as number);
      deleted += doomed.length;
    }
    // Even with nothing to delete now, an earlier delete may have left the match in a free page or the WAL.
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.run("VACUUM");
    return deleted;
  } finally {
    db.close();
  }
}

function matchesText(value: unknown, pattern: RegExp): boolean {
  if (typeof value !== "string") return false;
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/** The Claude Code transcripts that hold a match. */
function transcriptsHolding(pattern: RegExp): string[] {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return filesUnder(join(config, "projects")).filter((path) => {
    try {
      return path.endsWith(".jsonl") && matchesText(readFileSync(path, "utf8"), pattern);
    } catch {
      return false;
    }
  });
}
