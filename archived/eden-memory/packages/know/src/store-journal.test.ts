import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePack } from "./pack";
import { CRAWL_FILE, JNL_FILE, junkFrontier, openQueryStore, openStore } from "./store";

function sizes(dir: string) {
  const names = ["graph.sqlite", "graph.sqlite-wal", "graph.sqlite-shm", "graph.kpk", JNL_FILE, "seen.bin", CRAWL_FILE];
  const out: Record<string, number> = {};
  let sqliteWal = 0;
  let ingest = 0;
  for (const n of names) {
    const p = join(dir, n);
    const b = existsSync(p) ? statSync(p).size : 0;
    out[n] = b;
    if (n === "graph.sqlite" || n === "graph.sqlite-wal") sqliteWal += b;
    if (n === "graph.sqlite" || n === "graph.sqlite-wal" || n === JNL_FILE || n === "seen.bin" || n === CRAWL_FILE)
      ingest += b;
  }
  out.sqlite_wal = sqliteWal;
  out.ingest = ingest;
  return out;
}

function crawlMagic(dir: string) {
  const p = join(dir, CRAWL_FILE);
  if (!existsSync(p)) return "";
  return readFileSync(p).subarray(0, 4).toString("ascii");
}

describe("ingest journal", () => {
  test("query store never opens sqlite and ignores journal until compact", () => {
    const packed = mkdtempSync(join(tmpdir(), "eden-know-jnl-pack-"));
    writeFileSync(
      join(packed, "graph.kpk"),
      encodePack([{ s: "RFC 3986", p: "is", o: "URI Generic Syntax", e: "", url: "" }]),
    );
    const q0 = openQueryStore(packed);
    expect(q0.search("RFC 3986")[0]?.o).toContain("URI");
    q0.close?.();
    expect(existsSync(join(packed, "graph.sqlite"))).toBe(false);
    rmSync(packed, { recursive: true, force: true });

    const dir = mkdtempSync(join(tmpdir(), "eden-know-jnl-q-"));
    const s = openStore(dir);
    s.putNodes(
      "https://example.org/a",
      [{ s: "jq", p: "is", o: "used for filtering JSON", e: "jq is used for filtering JSON on the command line." }],
      30,
    );
    expect(s.search("jq")[0]?.s).toBe("jq");
    const q = openQueryStore(dir);
    expect(q.search("jq").length).toBe(0);
    q.close?.();
    s.compact();
    const q2 = openQueryStore(dir);
    expect(q2.search("jq")[0]?.s).toBe("jq");
    q2.close?.();
    s.close();
    expect(existsSync(join(dir, "graph.sqlite"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("compact keeps city-state capitals and drops overlay tautology junk", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-jnl-citystate-"));
    writeFileSync(
      join(dir, "graph.kpk"),
      encodePack([
        { s: "Singapore", p: "capital", o: "Singapore", e: "", url: "" },
        { s: "Germany", p: "capital", o: "Berlin", e: "", url: "" },
        { s: "RFC 3986", p: "is", o: "URI Generic Syntax", e: "", url: "" },
      ]),
    );
    const s = openStore(dir);
    s.putNodes(
      "https://example.org/b",
      [
        { s: "Berlin", p: "capital", o: "Berlin", e: "" },
        { s: "Vatican City", p: "capital", o: "Vatican City", e: "" },
      ],
      30,
    );
    s.compact();
    expect(s.search("Singapore").length).toBe(0);
    expect(s.search("Germany").length).toBe(0);
    expect(s.search("Berlin").some((h) => h.p === "capital" && h.s === "Berlin")).toBe(false);
    expect(
      s.search("Vatican City").some((h) => h.p === "capital" && h.s === "Vatican City" && h.o === "Vatican City"),
    ).toBe(false);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("compact drops wiki-template is-rows even if they were already packed", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-jnl-wikijunk-"));
    writeFileSync(
      join(dir, "graph.kpk"),
      encodePack([
        { s: "Kenya", p: "capital", o: "Nairobi", e: "", url: "https://en.wikipedia.org/wiki/Kenya" },
        { s: "Hop Bottom, Pennsylvania", p: "is", o: "a |leader_title =", e: "", url: "" },
        { s: "Hop Bottom", p: "is", o: "the official name of Hop Bottom, Pennsylvania", e: "", url: "" },
        { s: "Platanoussa", p: "is", o: "situated on the eastern slope of the [[Xerovouni]] mountain", e: "", url: "" },
        { s: "Latin", p: "is", o: "the motto of HMS Achates (H12)", e: "", url: "" },
        { s: "Unincorporated community", p: "is", o: "the official name of Coalton, Kentucky", e: "", url: "" },
        { s: "RFC 3986", p: "is", o: "URI Generic Syntax", e: "", url: "" },
      ]),
    );
    const s = openStore(dir);
    s.compact();
    expect(s.search("Kenya").length).toBe(0);
    expect(s.search("RFC 3986").length).toBe(0);
    expect(s.search("Hop Bottom").some((h) => /leader_title|official name of Hop Bottom/i.test(`${h.s} ${h.o}`))).toBe(
      false,
    );
    expect(s.search("Platanoussa").some((h) => /\[\[/.test(h.o))).toBe(false);
    expect(s.search("Latin").some((h) => /motto of/i.test(h.o))).toBe(false);
    expect(s.search("Unincorporated community").length).toBe(0);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("journal round-trips overlay across reopen; compact merges into pack", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-jnl-rt-"));
    const s = openStore(dir);
    s.putNodes(
      "https://example.org/a",
      [{ s: "jq", p: "is", o: "used for filtering JSON", e: "jq is used for filtering JSON on the command line." }],
      30,
    );
    s.close();
    const s2 = openStore(dir);
    expect(s2.search("jq")[0]?.s).toBe("jq");
    expect(s2.count().wal_nodes).toBeGreaterThanOrEqual(1);
    const q = openQueryStore(dir);
    expect(q.search("jq").length).toBe(0);
    q.close?.();
    s2.compact();
    expect(s2.count().wal_nodes).toBe(0);
    expect(s2.search("jq")[0]?.s).toBe("jq");
    s2.close();
    const q2 = openQueryStore(dir);
    expect(q2.search("jq")[0]?.s).toBe("jq");
    q2.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  test("skip digest equality via pageDigest; skip rows stay out of pages", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-jnl-seen-"));
    const s = openStore(dir);
    s.putPage({ url: "https://spam.example/x", digest: "abc", chars: 10, source: "cc", ttl_days: 1, skip: "language" });
    expect((s.db.query(`SELECT COUNT(*) AS n FROM pages`).get() as { n: number }).n).toBe(0);
    expect(s.pageDigest("https://spam.example/x")).toBe("abc");
    s.close();
    const s2 = openStore(dir);
    expect(s2.pageDigest("https://spam.example/x")).toBe("abc");
    expect((s2.db.query(`SELECT COUNT(*) AS n FROM pages`).get() as { n: number }).n).toBe(0);
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("legacy seen.bin url\\tdigest frames migrate on openStore", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-jnl-seen-legacy-"));
    const url = "https://spam.example/legacy-frame";
    const payload = Buffer.from(`${url}\tabc-digest\n`, "utf8");
    const head = Buffer.alloc(5);
    head.writeUInt32LE(payload.byteLength, 0);
    head[4] = 0;
    writeFileSync(join(dir, "seen.bin"), Buffer.concat([Buffer.from("KNS1", "ascii"), head, payload]));
    const s = openStore(dir);
    expect(s.pageDigest(url)).toBe("abc-digest");
    s.close();
    const s2 = openStore(dir);
    expect(s2.pageDigest(url)).toBe("abc-digest");
    const disk = readFileSync(join(dir, "seen.bin"));
    expect(disk.subarray(0, 4).toString("ascii")).toBe("KNS1");
    expect(disk.toString("utf8")).not.toContain(`${url}\tabc-digest`);
    expect(disk[9]).toBe(4);
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("after compact sqlite+wal is pack-scale for ~200 triples", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-jnl-sz-"));
    const s = openStore(dir);
    const triples = Array.from({ length: 200 }, (_, i) => ({
      s: `Tool${i}`,
      p: "is" as const,
      o: `used for task number ${i} work`,
      e: `Tool${i} is used for task number ${i} work`,
    }));
    s.putNodes("https://example.org/caps", triples, 30);
    s.compact();
    s.close();
    const z = sizes(dir);
    expect(z.sqlite_wal).toBeLessThan(200_000);
    expect(z.sqlite_wal).toBeLessThan(50_000);
    expect(z[JNL_FILE] ?? 0).toBeLessThan(64);
    expect(z["graph.kpk"]).toBeGreaterThan(0);
    expect(existsSync(join(dir, "graph.sqlite"))).toBe(false);
    expect(crawlMagic(dir)).toBe("KNC1");
    rmSync(dir, { recursive: true, force: true });
  });

  test("legacy overlay sqlite folds into journal and sqlite+wal shrinks under 50 KB", () => {
    const src = mkdtempSync(join(tmpdir(), "eden-know-legacy-src-"));
    const fixture = join(src, "legacy.sqlite");
    const fat = new Database(fixture);
    fat.exec(`
      CREATE TABLE intern (id INTEGER PRIMARY KEY, s TEXT NOT NULL UNIQUE);
      CREATE TABLE evidence (id INTEGER PRIMARY KEY, h TEXT NOT NULL UNIQUE, t TEXT NOT NULL, n \
INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY,
        sid INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        oid INTEGER NOT NULL,
        eid INTEGER NOT NULL,
        url TEXT,
        as_of INTEGER,
        ttl_days INTEGER
      );
      CREATE UNIQUE INDEX nodes_sp ON nodes(sid, pid);
      CREATE TABLE lex (id INTEGER PRIMARY KEY, t TEXT NOT NULL UNIQUE);
      CREATE TABLE post (tid INTEGER NOT NULL, nid INTEGER NOT NULL, PRIMARY KEY (tid, nid)) WITHOUT ROWID;
      CREATE TABLE pages (
        url TEXT PRIMARY KEY,
        digest TEXT,
        chars INTEGER,
        source TEXT,
        fetched_at INTEGER,
        ttl_days INTEGER
      ) WITHOUT ROWID;
      CREATE TABLE frontier (url TEXT PRIMARY KEY, next_fetch INTEGER, from_url TEXT);
      CREATE TABLE host_prior (host TEXT PRIMARY KEY, kept INTEGER NOT NULL DEFAULT 0, skipped \
INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE mh_band (band TEXT PRIMARY KEY, url TEXT);
      CREATE TABLE seen_digest (url TEXT PRIMARY KEY, digest TEXT);
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    const insI = fat.prepare(`INSERT INTO intern(s) VALUES (?)`);
    const idOf = fat.prepare(`SELECT id FROM intern WHERE s = ?`);
    const intern = (s: string) => {
      insI.run(s);
      return (idOf.get(s) as { id: number }).id;
    };
    const pad = "z".repeat(800);
    for (let i = 0; i < 400; i++) intern(`pad ${i} ${pad}`);
    const used = intern("is");
    const now = Date.now();
    const insN = fat.prepare(`INSERT INTO nodes(sid,pid,oid,eid,url,as_of,ttl_days) VALUES (?,?,?,?,?,?,?)`);
    for (let i = 0; i < 200; i++) {
      insN.run(
        intern(`Tool${i}`),
        used,
        intern(`used for task ${i} work`),
        intern(`Tool${i} is used for task ${i} work.`),
        "https://example.org/tools",
        now,
        30,
      );
    }
    fat.run(`INSERT INTO pages(url,digest,chars,source,fetched_at,ttl_days) VALUES (?,?,?,?,?,?)`, [
      "https://example.org/kept",
      "keep-digest",
      12,
      "cc",
      now,
      30,
    ]);
    fat.run(`INSERT INTO frontier(url, next_fetch, from_url) VALUES (?,?,?)`, [
      "https://example.org/queued",
      now,
      "https://example.org/caps",
    ]);
    fat.run(`INSERT INTO host_prior(host, kept, skipped) VALUES (?,?,?)`, ["example.org", 4, 1]);
    fat.run(`INSERT INTO seen_digest(url, digest) VALUES (?,?)`, ["https://spam.example/x", "skip-digest"]);
    fat.exec(`PRAGMA user_version = 10`);
    fat.close();
    expect(statSync(fixture).size).toBeGreaterThan(50_000);

    const dir = mkdtempSync(join(tmpdir(), "eden-know-legacy-dst-"));
    copyFileSync(fixture, join(dir, "graph.sqlite"));
    const s = openStore(dir);
    expect(s.search("Tool0")[0]?.o).toContain("used for task 0");
    expect(s.count().wal_nodes).toBeGreaterThanOrEqual(200);
    expect(s.pageDigest("https://example.org/kept")).toBe("keep-digest");
    expect(s.pageDigest("https://spam.example/x")).toBe("skip-digest");
    expect(
      (s.db.query(`SELECT COUNT(*) AS n FROM pages WHERE url = 'https://example.org/kept'`).get() as { n: number }).n,
    ).toBe(1);
    expect(
      (s.db.query(`SELECT COUNT(*) AS n FROM frontier WHERE url = 'https://example.org/queued'`).get() as { n: number })
        .n,
    ).toBe(1);
    expect((s.db.query(`SELECT kept FROM host_prior WHERE host = 'example.org'`).get() as { kept: number }).kept).toBe(
      4,
    );
    s.close();

    const z = sizes(dir);
    expect(z.sqlite_wal).toBeLessThan(50_000);
    expect(z[JNL_FILE] ?? 0).toBeGreaterThan(0);
    expect(existsSync(join(dir, "graph.sqlite"))).toBe(false);
    expect(crawlMagic(dir)).toBe("KNC1");

    const s2 = openStore(dir);
    expect(
      (s2.db.query(`SELECT digest FROM pages WHERE url = 'https://example.org/kept'`).get() as { digest: string })
        .digest,
    ).toBe("keep-digest");
    expect(
      (
        s2.db.query(`SELECT COUNT(*) AS n FROM frontier WHERE url = 'https://example.org/queued'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect((s2.db.query(`SELECT kept FROM host_prior WHERE host = 'example.org'`).get() as { kept: number }).kept).toBe(
      4,
    );
    s2.close();

    rmSync(src, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test("near-dup matches other URLs; same URL is not a dup", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-mh-"));
    const s = openStore(dir);
    const text =
      "the capital of kenya is nairobi and the country lies on the equator with a long indian ocean coastline ".repeat(
        6,
      );
    const other =
      "quantum chromodynamics lagrangian density of the standard model of particle physics and gauge bosons ".repeat(6);
    expect(s.nearDup("https://example.org/a", text)).toBe(false);
    expect(s.nearDup("https://example.org/a", text)).toBe(false);
    expect(s.nearDup("https://example.org/b", text)).toBe(true);
    expect(s.nearDup("https://example.org/c", other)).toBe(false);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("compact-scale sqlite+wal after pages+nearDup+checkpoint is under 56 KB at 512-byte pages", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-sz-compact-"));
    const s = openStore(dir);
    const body =
      "the capital of kenya is nairobi and the country lies on the equator with a long indian ocean coastline ".repeat(
        5,
      );
    for (let i = 0; i < 72; i++) {
      const url = `https://example.org/p/${i}`;
      s.putPage({ url, digest: `d${i}`, chars: 400, source: "cc", ttl_days: 7 });
      s.nearDup(url, `${body} page-${i} unique token ${i}`);
    }
    s.enqueue(
      Array.from({ length: 80 }, (_, i) => `https://example.org/q/${i}`),
      "https://example.org/feed",
    );
    s.close();
    const z = sizes(dir);
    expect(z.sqlite_wal).toBeLessThanOrEqual(56_000);
    expect(z.ingest).toBeLessThanOrEqual(56_000);
    expect(z.ingest).toBeLessThan(24_000);
    expect(existsSync(join(dir, "graph.sqlite"))).toBe(false);
    expect(crawlMagic(dir)).toBe("KNC1");
    const s2 = openStore(dir);
    expect((s2.db.query(`SELECT COUNT(*) AS n FROM pages`).get() as { n: number }).n).toBe(72);
    expect(
      (s2.db.query(`SELECT COUNT(*) AS n FROM pages WHERE url = 'https://example.org/p/0'`).get() as { n: number }).n,
    ).toBe(1);
    expect((s2.db.query(`PRAGMA table_info(pages)`).all() as { name: string }[]).map((c) => c.name)).toContain("url");
    expect((s2.db.query(`PRAGMA table_info(pages)`).all() as { name: string }[]).some((c) => c.name === "skip")).toBe(
      false,
    );
    expect((s2.db.query(`SELECT COUNT(*) AS n FROM frontier`).get() as { n: number }).n).toBeGreaterThanOrEqual(80);
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("fat TEXT mh_band at 4096-byte pages vacuums to compact 512-byte sqlite", () => {
    const src = mkdtempSync(join(tmpdir(), "eden-know-fat-src-"));
    const fixture = join(src, "fat.sqlite");
    const fat = new Database(fixture);
    fat.exec(`
      CREATE TABLE pages (
        url TEXT PRIMARY KEY,
        digest TEXT,
        chars INTEGER,
        source TEXT,
        fetched_at INTEGER,
        ttl_days INTEGER
      ) WITHOUT ROWID;
      CREATE TABLE frontier (url TEXT PRIMARY KEY, next_fetch INTEGER, from_url TEXT);
      CREATE TABLE host_prior (host TEXT PRIMARY KEY, kept INTEGER NOT NULL DEFAULT 0, skipped \
INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE mh_band (band TEXT PRIMARY KEY, url TEXT);
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    const now = Date.now();
    const insP = fat.prepare(`INSERT INTO pages(url,digest,chars,source,fetched_at,ttl_days) VALUES (?,?,?,?,?,?)`);
    for (let i = 0; i < 72; i++) {
      insP.run(`https://stackoverflow.com/questions/${i}/how-to-parse-json-with-jq`, `digest${i}`, 1200, "cc", now, 30);
    }
    const insF = fat.prepare(`INSERT INTO frontier(url, next_fetch, from_url) VALUES (?,?,?)`);
    for (let i = 0; i < 400; i++) {
      insF.run(
        `https://old.reddit.com/r/commandline/comments/${i}/jq_filter_title`,
        now,
        i % 4 === 0 ? "seed" : "https://old.reddit.com/r/commandline/",
      );
    }
    const insH = fat.prepare(`INSERT INTO host_prior(host, kept, skipped) VALUES (?,?,?)`);
    for (let i = 0; i < 1200; i++) insH.run(`junk-${i}.example`, i < 250 ? 2 : 0, 12);
    const insM = fat.prepare(`INSERT INTO mh_band(band, url) VALUES (?,?)`);
    for (let i = 0; i < 1500; i++) {
      insM.run(
        Array.from({ length: 8 }, (_, j) => (i * 8 + j) * 1_000_003).join("."),
        `https://stackoverflow.com/questions/${i}/how-to-parse-json-with-jq-on-the-command-line-without-loading`,
      );
    }
    fat.exec(`PRAGMA user_version = 11`);
    fat.close();
    const before = statSync(fixture).size;
    expect(before).toBeGreaterThan(200_000);

    const dir = mkdtempSync(join(tmpdir(), "eden-know-fat-dst-"));
    copyFileSync(fixture, join(dir, "graph.sqlite"));
    const s = openStore(dir);
    expect((s.db.query(`SELECT COUNT(*) AS n FROM pages`).get() as { n: number }).n).toBe(72);
    expect((s.db.query(`SELECT COUNT(*) AS n FROM frontier`).get() as { n: number }).n).toBeGreaterThanOrEqual(400);
    const text =
      "the capital of kenya is nairobi and the country lies on the equator with a long indian ocean coastline ".repeat(
        6,
      );
    expect(s.nearDup("https://example.org/x", text)).toBe(false);
    expect(s.nearDup("https://example.org/y", text)).toBe(true);
    expect((s.db.query(`SELECT COUNT(*) AS n FROM host_prior WHERE kept = 0`).get() as { n: number }).n).toBe(0);
    s.close();

    const z = sizes(dir);
    expect(z.sqlite_wal).toBeLessThan(before / 10);
    expect(z.sqlite_wal).toBeLessThanOrEqual(56_000);
    expect(z.ingest).toBeLessThan(before / 10);
    expect(z.ingest).toBeLessThanOrEqual(56_000);
    expect(existsSync(join(dir, "graph.sqlite"))).toBe(false);
    expect(crawlMagic(dir)).toBe("KNC1");

    rmSync(src, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test("interned frontier/pages URLs round-trip; enqueue/dequeue keep full strings", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-url-intern-"));
    const s = openStore(dir);
    const long =
      "https://stackoverflow.com/questions/12345678/" +
      "how-to-parse-json-with-jq-on-the-command-line-without-loading-the-entire-file";
    const httpSlash = "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd";
    const qhash = "https://example.org/path/page?format=json&limit=200#frag";
    s.enqueue([long, httpSlash, qhash, "https://example.org/queued"], "https://example.org/feed");
    s.putPage({ url: "https://example.org/kept", digest: "keep-digest", chars: 12, source: "cc", ttl_days: 30 });
    const queued = (s.db.query(`SELECT url FROM frontier`).all() as { url: string }[]).map((r) => r.url);
    expect(queued).toContain(long);
    expect(queued).toContain(httpSlash);
    expect(queued).toContain("https://example.org/path/page?format=json&limit=200");
    expect(queued).toContain("https://example.org/queued");
    expect(
      (s.db.query(`SELECT digest FROM pages WHERE url = 'https://example.org/kept'`).get() as { digest: string })
        .digest,
    ).toBe("keep-digest");
    const taken = s.takeFrontier(2000);
    expect(taken).toContain(long);
    expect(taken).toContain(httpSlash);
    expect(taken).toContain("https://example.org/path/page?format=json&limit=200");
    expect(s.schemaVersion()).toBe(15);
    s.close();

    expect(existsSync(join(dir, "graph.sqlite"))).toBe(false);
    expect(crawlMagic(dir)).toBe("KNC1");
    expect(readFileSync(join(dir, CRAWL_FILE))[4]).toBe(8);
    const s2 = openStore(dir);
    expect(
      (s2.db.query(`SELECT digest FROM pages WHERE url = 'https://example.org/kept'`).get() as { digest: string })
        .digest,
    ).toBe("keep-digest");
    expect(
      (s2.db.query(`PRAGMA table_info(pages)`).all() as { name: string }[]).some(
        (c) => c.name === "skip" || c.name === "url",
      ),
    ).toBe(true);
    expect((s2.db.query(`PRAGMA table_info(pages)`).all() as { name: string }[]).some((c) => c.name === "skip")).toBe(
      false,
    );
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("leftover sqlite overlay is not copied; pack-duplicate SNAP journal becomes magic-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-jnl-leftover-"));
    const s = openStore(dir);
    const jq = {
      s: "jq",
      p: "is" as const,
      o: "used for filtering JSON",
      e: "jq is used for filtering JSON on the command line.",
      url: "",
    };
    s.putNodes("https://example.org/a", [jq], 30);
    s.enqueue(["https://example.org/queued"], "https://example.org/feed");
    s.close();
    expect(statSync(join(dir, JNL_FILE)).size).toBeGreaterThan(4);
    writeFileSync(join(dir, "graph.kpk"), encodePack([jq]));
    if (!existsSync(join(dir, "seen.bin"))) writeFileSync(join(dir, "seen.bin"), Buffer.from("KNS1", "ascii"));

    const leftover = new Database(join(dir, "graph.sqlite"));
    leftover.exec(`
      CREATE TABLE intern (id INTEGER PRIMARY KEY, s TEXT NOT NULL UNIQUE);
      CREATE TABLE evidence (id INTEGER PRIMARY KEY, h TEXT NOT NULL UNIQUE, t TEXT NOT NULL, n \
INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY,
        sid INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        oid INTEGER NOT NULL,
        eid INTEGER NOT NULL,
        url TEXT,
        as_of INTEGER,
        ttl_days INTEGER
      );
      CREATE UNIQUE INDEX nodes_sp ON nodes(sid, pid);
    `);
    leftover.run(`INSERT INTO intern(s) VALUES (?)`, ["ExtraCountry"]);
    leftover.run(`INSERT INTO intern(s) VALUES (?)`, ["capital"]);
    leftover.run(`INSERT INTO intern(s) VALUES (?)`, ["Nowhere"]);
    leftover.run(`INSERT INTO nodes(sid,pid,oid,eid,url,as_of,ttl_days) VALUES (?,?,?,?,?,?,?)`, [
      1,
      2,
      3,
      0,
      "https://example.org/extra",
      Date.now(),
      30,
    ]);
    leftover.close();

    const s2 = openStore(dir);
    expect(s2.search("jq")[0]?.o).toContain("filtering JSON");
    expect(s2.count().wal_nodes).toBe(0);
    expect(s2.search("ExtraCountry").length).toBe(0);
    expect(
      (
        s2.db.query(`SELECT COUNT(*) AS n FROM frontier WHERE url = 'https://example.org/queued'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    s2.close();
    expect(statSync(join(dir, JNL_FILE)).size).toBe(4);
    expect(existsSync(join(dir, "graph.sqlite"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("crush + enqueue drop blogs/apod/nist CMS/wiki; keep RFC, W3C TR, talk, news, seeds", () => {
    const nist = "https://www.nist.gov/news-events/news/2026/08/spooky-particles";
    const news = "https://www.w3.org/news/2026/pointer-events-level-3/";
    const blog = "https://commoncrawl.org/blog/august-2026-crawl-archive-now-available";
    const apod = "https://science.nasa.gov/solar-system/apod/image-article/foo";
    const rfc = "https://www.rfc-editor.org/rfc/rfc9110.html";
    const tr = "https://www.w3.org/TR/web-share/";
    const wiki = "https://en.wikipedia.org/wiki/Kenya";
    const caps = "https://en.wikipedia.org/wiki/List_of_national_capitals";
    const talk = "https://old.reddit.com/r/commandline/comments/x/jq";
    expect(junkFrontier(nist)).toBe(true);
    expect(junkFrontier(news)).toBe(false);
    expect(junkFrontier(blog)).toBe(true);
    expect(junkFrontier(apod)).toBe(true);
    expect(junkFrontier(rfc)).toBe(false);
    expect(junkFrontier(tr)).toBe(false);
    expect(junkFrontier(wiki)).toBe(true);
    expect(junkFrontier(caps)).toBe(true);
    expect(junkFrontier(talk)).toBe(false);
    expect(junkFrontier("https://www.nist.gov/")).toBe(true);
    expect(junkFrontier("https://www.reuters.com/world/asia/story")).toBe(false);
    expect(junkFrontier("https://example.org/queued")).toBe(false);
    expect(junkFrontier("https://github.com/oven-sh/bun")).toBe(false);
    expect(junkFrontier("https://github.com/random-user/hello")).toBe(true);
    expect(junkFrontier("https://github.com/oven-sh/bun/issues/1")).toBe(false);
    expect(junkFrontier("https://docs.python.org/3/")).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "eden-know-crush-"));
    const s = openStore(dir);
    s.enqueue(
      [
        nist,
        news,
        blog,
        apod,
        rfc,
        tr,
        wiki,
        caps,
        talk,
        "https://www.reuters.com/world/asia/story",
        "https://example.org/queued",
        "https://github.com/oven-sh/bun",
        "https://github.com/random-user/hello",
        "https://github.com/oven-sh/bun/issues/1",
        "https://docs.python.org/3/",
      ],
      "https://example.org/feed",
    );
    const queued = (s.db.query(`SELECT url FROM frontier`).all() as { url: string }[]).map((r) => r.url);
    expect(queued).not.toContain(nist);
    expect(queued).toContain("https://www.w3.org/news/2026/pointer-events-level-3");
    expect(queued).not.toContain(blog);
    expect(queued).not.toContain(apod);
    expect(queued).toContain(rfc);
    expect(queued).toContain(tr);
    expect(queued).not.toContain(wiki);
    expect(queued).not.toContain(caps);
    expect(queued).toContain(talk);
    expect(queued).toContain("https://www.reuters.com/world/asia/story");
    expect(queued).toContain("https://example.org/queued");
    expect(queued).toContain("https://github.com/oven-sh/bun");
    expect(queued).toContain("https://docs.python.org/3");
    expect(queued).not.toContain("https://github.com/random-user/hello");
    expect(queued.some((u) => /\/issues\//.test(u))).toBe(true);
    expect(queued.some((u) => /nist\.gov/i.test(u))).toBe(false);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
