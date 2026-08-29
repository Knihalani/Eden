import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Triple } from "./extract";
import { hostOf, persistable, qualityHost, qualityUrlSql } from "./extract";
import { minhashBands } from "./minhash";
import { decodePack, encodePack, mergeFacts, PACK_FILE, type KnowPack, type PackFact } from "./pack";
import { catalogAliasKeys, indexTokens, queryTokens } from "./tokens";
import { catalogSubject } from "./names";
import { SEED_URLS } from "./seed";

export type KnowStore = ReturnType<typeof openStore>;

export function knowDir(): string {
  return process.env.EDEN_KNOW_DIR || join(process.env.EDEN_HOME || join(homedir(), ".eden"), "know");
}

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function migrateV2(db: Database) {
  const ver = Number((db.query(`PRAGMA user_version`).get() as { user_version: number } | null)?.user_version ?? 0);
  if (ver >= 2) return;
  const cols = (db.query(`PRAGMA table_info(nodes)`).all() as { name: string }[]).map((c) => c.name);
  const legacy = cols.includes("s") && !cols.includes("sid");
  db.exec(`
    CREATE TABLE IF NOT EXISTS intern (id INTEGER PRIMARY KEY, s TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS evidence (id INTEGER PRIMARY KEY, h TEXT NOT NULL UNIQUE, t TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS host_prior (host TEXT PRIMARY KEY, kept INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS mh_band (band TEXT PRIMARY KEY, url TEXT);
    CREATE TABLE IF NOT EXISTS seen_digest (url TEXT PRIMARY KEY, digest TEXT);
  `);
  if (legacy) {
    db.exec(`ALTER TABLE nodes RENAME TO nodes_legacy`);
    db.exec(`
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
      CREATE INDEX IF NOT EXISTS nodes_url ON nodes(url);
      CREATE INDEX IF NOT EXISTS nodes_sid ON nodes(sid);
    `);
    const insI = db.prepare(`INSERT OR IGNORE INTO intern(s) VALUES (?)`);
    const idOf = db.prepare(`SELECT id FROM intern WHERE s = ?`);
    const insE = db.prepare(`INSERT OR IGNORE INTO evidence(h,t,n) VALUES (?,?,1)`);
    const eidOf = db.prepare(`SELECT id FROM evidence WHERE h = ?`);
    const bumpE = db.prepare(`UPDATE evidence SET n = n + 1 WHERE h = ?`);
    const insN = db.prepare(`INSERT INTO nodes(sid,pid,oid,eid,url,as_of,ttl_days) VALUES (?,?,?,?,?,?,?)`);
    const rows = db.query(`SELECT s,p,o,e,url,as_of,ttl_days FROM nodes_legacy`).all() as {
      s: string; p: string; o: string; e: string; url: string; as_of: number; ttl_days: number;
    }[];
    const internId = (s: string) => {
      insI.run(s);
      return (idOf.get(s) as { id: number }).id;
    };
    for (const r of rows) {
      const h = sha16(r.e || "");
      const existed = eidOf.get(h);
      if (existed) bumpE.run(h);
      else insE.run(h, r.e || "");
      const eid = (eidOf.get(h) as { id: number }).id;
      insN.run(internId(r.s), internId(r.p), internId(r.o), eid, r.url, r.as_of, r.ttl_days);
    }
    db.exec(`DROP TABLE nodes_legacy`);
    try {
      db.exec(`DROP TABLE IF EXISTS nodes_fts`);
    } catch {
      /* */
    }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(s, p, o)`);
    const ftsIns = db.prepare(`INSERT INTO nodes_fts(rowid, s, p, o) VALUES (?,?,?,?)`);
    const rebuilt = db.query(`
      SELECT n.id, s.s AS s, p.s AS p, o.s AS o
      FROM nodes n
      JOIN intern s ON s.id = n.sid
      JOIN intern p ON p.id = n.pid
      JOIN intern o ON o.id = n.oid
    `).all() as { id: number; s: string; p: string; o: string }[];
    for (const r of rebuilt) ftsIns.run(r.id, r.s, r.p, r.o);
  } else if (!cols.includes("sid")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY,
        sid INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        oid INTEGER NOT NULL,
        eid INTEGER NOT NULL,
        url TEXT,
        as_of INTEGER,
        ttl_days INTEGER
      );
      CREATE INDEX IF NOT EXISTS nodes_url ON nodes(url);
      CREATE INDEX IF NOT EXISTS nodes_sid ON nodes(sid);
    `);
  }
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(s, p, o)`);
  db.exec(`PRAGMA user_version = 2`);
}

function migrateV3(db: Database) {
  const ver = Number((db.query(`PRAGMA user_version`).get() as { user_version: number } | null)?.user_version ?? 0);
  if (ver >= 3) return;
  try {
    db.run(`DELETE FROM pages WHERE skip != ''`);
  } catch {
    /* */
  }
  try {
    db.exec(`DROP TABLE IF EXISTS nodes_fts`);
  } catch {
    /* */
  }
  try {
    db.run(
      `UPDATE evidence SET t = '' WHERE length(t) > 80 AND id NOT IN (
         SELECT n.eid FROM nodes n JOIN intern p ON p.id = n.pid WHERE p.s IN ('capital','is')
       )`,
    );
  } catch {
    /* empty graph */
  }
  db.exec(`PRAGMA user_version = 3`);
}

function migrateV4(db: Database) {
  const ver = Number((db.query(`PRAGMA user_version`).get() as { user_version: number } | null)?.user_version ?? 0);
  db.exec(`CREATE TABLE IF NOT EXISTS lex (id INTEGER PRIMARY KEY, t TEXT NOT NULL UNIQUE)`);
  if (ver >= 4) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS post (tid INTEGER NOT NULL, nid INTEGER NOT NULL, PRIMARY KEY (tid, nid)) WITHOUT ROWID`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS post_nid ON post(nid)`);
    return;
  }
  try {
    db.run(
      `DELETE FROM nodes WHERE pid IN (SELECT id FROM intern WHERE s NOT IN ('capital','is','date','id','version'))`,
    );
  } catch {
    /* */
  }
  const pageCols = (db.query(`PRAGMA table_info(pages)`).all() as { name: string }[]).map((c) => c.name);
  if (pageCols.includes("skip") || !pageCols.includes("url")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pages_v4 (
        url TEXT PRIMARY KEY,
        digest TEXT,
        chars INTEGER,
        source TEXT,
        fetched_at INTEGER,
        ttl_days INTEGER
      ) WITHOUT ROWID
    `);
    try {
      db.exec(
        `INSERT OR IGNORE INTO pages_v4(url,digest,chars,source,fetched_at,ttl_days)
         SELECT url, digest, chars, source, fetched_at, ttl_days FROM pages WHERE COALESCE(skip,'') = ''`,
      );
    } catch {
      db.exec(
        `INSERT OR IGNORE INTO pages_v4(url,digest,chars,source,fetched_at,ttl_days)
         SELECT url, digest, chars, source, fetched_at, ttl_days FROM pages`,
      );
    }
    db.exec(`DROP TABLE IF EXISTS pages`);
    db.exec(`ALTER TABLE pages_v4 RENAME TO pages`);
  }
  db.exec(`DROP TABLE IF EXISTS post`);
  db.exec(
    `CREATE TABLE post (tid INTEGER NOT NULL, nid INTEGER NOT NULL, PRIMARY KEY (tid, nid)) WITHOUT ROWID`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS post_nid ON post(nid)`);
  const insL = db.prepare(`INSERT OR IGNORE INTO lex(t) VALUES (?)`);
  const getL = db.prepare(`SELECT id FROM lex WHERE t = ?`);
  const insP = db.prepare(`INSERT OR IGNORE INTO post(tid, nid) VALUES (?,?)`);
  try {
    const rows = db
      .query(
        `SELECT n.id, s.s AS s, p.s AS p, o.s AS o
         FROM nodes n
         JOIN intern s ON s.id = n.sid
         JOIN intern p ON p.id = n.pid
         JOIN intern o ON o.id = n.oid`,
      )
      .all() as { id: number; s: string; p: string; o: string }[];
    for (const r of rows) {
      const t = { s: r.s, p: r.p, o: r.o, e: "" };
      const words = catalogSubject(r.s) ? catalogAliasKeys(t) : indexTokens(t);
      for (const w of words) {
        insL.run(w);
        const tid = (getL.get(w) as { id: number }).id;
        insP.run(tid, r.id);
      }
    }
  } catch {
    /* */
  }
  try {
    db.run(
      `UPDATE nodes SET eid = 0 WHERE eid IN (SELECT id FROM evidence WHERE t = '')`,
    );
    db.run(`DELETE FROM evidence WHERE t = ''`);
  } catch {
    /* */
  }
  try {
    db.run(
      `DELETE FROM intern WHERE id NOT IN (
         SELECT sid FROM nodes UNION SELECT pid FROM nodes UNION SELECT oid FROM nodes
       )`,
    );
  } catch {
    /* */
  }
  db.run(`DELETE FROM seen_digest`);
  db.run(
    `INSERT INTO meta(k,v) VALUES ('need_reseed','1') ON CONFLICT(k) DO UPDATE SET v='1'`,
  );
  db.exec(`PRAGMA user_version = 4`);
}

function migrateV5(db: Database) {
  const ver = Number((db.query(`PRAGMA user_version`).get() as { user_version: number } | null)?.user_version ?? 0);
  if (ver >= 5) return;
  try {
    db.run(`DELETE FROM seen_digest`);
  } catch {
    /* */
  }
  db.run(
    `INSERT INTO meta(k,v) VALUES ('need_reseed','1') ON CONFLICT(k) DO UPDATE SET v='1'`,
  );
  db.exec(`PRAGMA user_version = 5`);
}

function migrateV6(db: Database) {
  const ver = Number((db.query(`PRAGMA user_version`).get() as { user_version: number } | null)?.user_version ?? 0);
  if (ver >= 6) return;
  try {
    db.run(`
      DELETE FROM nodes WHERE id NOT IN (
        SELECT n.id FROM nodes n
        JOIN intern p ON p.id = n.pid
        JOIN intern s ON s.id = n.sid
        WHERE p.s = 'capital'
           OR s.s LIKE 'RFC %'
           OR n.url LIKE '%rfc-editor.org%'
           OR n.url LIKE '%ietf.org%'
           OR n.url LIKE '%w3.org%'
           OR n.url LIKE '%nist.gov%'
           OR n.url LIKE '%nasa.gov%'
           OR n.url LIKE '%python.org%'
           OR n.url LIKE '%nodejs.org%'
           OR n.url LIKE '%httpwg.org%'
           OR n.url LIKE '%commoncrawl.org%'
           OR n.url LIKE '%govinfo.gov%'
      )
    `);
    db.run(`DELETE FROM post WHERE nid NOT IN (SELECT id FROM nodes)`);
    db.run(
      `DELETE FROM intern WHERE id NOT IN (
         SELECT sid FROM nodes UNION SELECT pid FROM nodes UNION SELECT oid FROM nodes
       )`,
    );
  } catch {
    /* */
  }
  db.exec(`PRAGMA user_version = 6`);
}

const QUALITY_URL_SQL = qualityUrlSql("url");

/** Soft ceiling for live crawl queue. Seeds are never evicted. */
const FRONTIER_CAP = 400;

/** Lower is fetched first. RFC/TR documents beat sitemap explosion. */
const FRONTIER_RANK_SQL = `CASE
  WHEN from_url = 'seed' THEN 0
  WHEN url LIKE '%rfc-editor.org/rfc/%'
    OR url LIKE '%datatracker.ietf.org/doc/html/rfc%'
    OR url LIKE '%httpwg.org/specs/%' THEN 1
  WHEN url LIKE '%w3.org/TR/%' OR url LIKE '%ietf.org/rfc/%' THEN 2
  WHEN from_url LIKE '%rss%' OR from_url LIKE '%feed%' OR from_url LIKE '%atom%' OR from_url LIKE '%sitemap%' THEN 3
  ELSE 4
END`;

function crushFrontier(db: Database) {
  db.run(`DELETE FROM frontier WHERE from_url != 'seed' AND NOT ${QUALITY_URL_SQL}`);
  db.run(
    `DELETE FROM frontier WHERE from_url != 'seed' AND (
       url LIKE '%image-article%' OR url LIKE '%apod%'
     )`,
  );
}

function requeueSeeds(db: Database) {
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO frontier(url, next_fetch, from_url) VALUES (?,?,?)
     ON CONFLICT(url) DO UPDATE SET from_url = 'seed', next_fetch = excluded.next_fetch`,
  );
  for (const u of SEED_URLS) ins.run(u, now, "seed");
}

function trimFrontier(db: Database) {
  const n = (db.query(`SELECT COUNT(*) AS n FROM frontier`).get() as { n: number }).n;
  if (n <= FRONTIER_CAP) return;
  const drop = n - FRONTIER_CAP;
  db.run(
    `DELETE FROM frontier WHERE url IN (
       SELECT url FROM (
         SELECT url FROM frontier
         WHERE from_url != 'seed'
         ORDER BY ${FRONTIER_RANK_SQL} DESC, next_fetch DESC
         LIMIT ?
       )
     )`,
    [drop],
  );
}

function migrateV7(db: Database) {
  const ver = Number((db.query(`PRAGMA user_version`).get() as { user_version: number } | null)?.user_version ?? 0);
  if (ver >= 7) return;
  try {
    db.run(`DELETE FROM pages WHERE url NOT IN (SELECT DISTINCT url FROM nodes WHERE url IS NOT NULL)`);
    db.run(`DELETE FROM frontier WHERE from_url != 'seed' AND NOT ${QUALITY_URL_SQL}`);
    db.run(`DELETE FROM mh_band`);
    db.run(`DELETE FROM seen_digest WHERE url NOT IN (SELECT DISTINCT url FROM nodes WHERE url IS NOT NULL) AND NOT ${QUALITY_URL_SQL}`);
  } catch {
    /* */
  }
  db.exec(`PRAGMA user_version = 7`);
}

function migrateV8(db: Database) {
  const ver = Number((db.query(`PRAGMA user_version`).get() as { user_version: number } | null)?.user_version ?? 0);
  if (ver >= 8) return;
  try {
    crushFrontier(db);
    requeueSeeds(db);
    trimFrontier(db);
  } catch {
    /* */
  }
  db.exec(`PRAGMA user_version = 8`);
}

function purgeHotJunk(db: Database) {
  try {
    db.run(`DELETE FROM nodes WHERE pid IN (SELECT id FROM intern WHERE s IN ('date','about'))`);
    db.run(
      `DELETE FROM nodes WHERE oid IN (
         SELECT id FROM intern WHERE length(s) > 72 OR s LIKE '%Light Dark%' OR s LIKE '%REP)%' OR s LIKE '%September 202%'
       )`,
    );
    db.run(`UPDATE evidence SET t = replace(replace(replace(t, ' Light Dark Auto RF', ''), ' Light Dark Auto', ''), ' Light Dar', '')`);
    db.run(`DELETE FROM post WHERE nid NOT IN (SELECT id FROM nodes)`);
    db.run(
      `DELETE FROM intern WHERE id NOT IN (
         SELECT sid FROM nodes UNION SELECT pid FROM nodes UNION SELECT oid FROM nodes
       )`,
    );
    db.run(`DELETE FROM pages WHERE url NOT IN (SELECT DISTINCT url FROM nodes WHERE url IS NOT NULL)`);
  } catch {
    /* */
  }
}

function migrateV9(db: Database) {
  const ver = Number((db.query(`PRAGMA user_version`).get() as { user_version: number } | null)?.user_version ?? 0);
  if (ver >= 9) return;
  purgeHotJunk(db);
  db.exec(`PRAGMA user_version = 9`);
}

function migrateV10(db: Database) {
  const ver = Number((db.query(`PRAGMA user_version`).get() as { user_version: number } | null)?.user_version ?? 0);
  if (ver >= 10) return;
  try {
    db.run(
      `DELETE FROM nodes WHERE id NOT IN (SELECT MIN(id) FROM nodes GROUP BY sid, pid)`,
    );
    db.run(`DELETE FROM post WHERE nid NOT IN (SELECT id FROM nodes)`);
    try {
      db.exec(`DROP INDEX IF EXISTS nodes_spo`);
    } catch {
      /* */
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS nodes_sp ON nodes(sid, pid)`);
  } catch {
    /* */
  }
  db.exec(`PRAGMA user_version = 10`);
}

export function openStore(dir = knowDir()) {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "graph.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=8000;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      url TEXT PRIMARY KEY,
      digest TEXT,
      chars INTEGER,
      source TEXT,
      fetched_at INTEGER,
      ttl_days INTEGER,
      skip TEXT
    );
    CREATE TABLE IF NOT EXISTS frontier (
      url TEXT PRIMARY KEY,
      next_fetch INTEGER,
      from_url TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  migrateV2(db);
  migrateV3(db);
  migrateV4(db);
  migrateV5(db);
  migrateV6(db);
  migrateV7(db);
  migrateV8(db);
  migrateV9(db);
  migrateV10(db);

  const packPath = join(dir, PACK_FILE);
  let pack: KnowPack | null = null;
  try {
    pack = decodePack(readFileSync(packPath));
  } catch {
    pack = null;
  }

  const internCache = new Map<string, number>();
  const insIntern = db.prepare(`INSERT OR IGNORE INTO intern(s) VALUES (?)`);
  const getIntern = db.prepare(`SELECT id FROM intern WHERE s = ?`);
  function intern(s: string): number {
    const hit = internCache.get(s);
    if (hit) return hit;
    insIntern.run(s);
    const id = (getIntern.get(s) as { id: number }).id;
    internCache.set(s, id);
    return id;
  }

  const lexCache = new Map<string, number>();
  const insLex = db.prepare(`INSERT OR IGNORE INTO lex(t) VALUES (?)`);
  const getLex = db.prepare(`SELECT id FROM lex WHERE t = ?`);
  function lex(t: string): number {
    const hit = lexCache.get(t);
    if (hit) return hit;
    insLex.run(t);
    const id = (getLex.get(t) as { id: number }).id;
    lexCache.set(t, id);
    return id;
  }

  const insEv = db.prepare(`INSERT OR IGNORE INTO evidence(h,t,n) VALUES (?,?,1)`);
  const getEv = db.prepare(`SELECT id FROM evidence WHERE h = ?`);
  const bumpEv = db.prepare(`UPDATE evidence SET n = n + 1 WHERE h = ?`);
  function casEvidence(text: string): number {
    if (!text) return 0;
    const h = sha16(text);
    const existed = getEv.get(h);
    if (existed) {
      bumpEv.run(h);
      return (existed as { id: number }).id;
    }
    insEv.run(h, text);
    return (getEv.get(h) as { id: number }).id;
  }

  const insMh = db.prepare(`INSERT OR IGNORE INTO mh_band(band, url) VALUES (?,?)`);
  const getMh = db.prepare(`SELECT url FROM mh_band WHERE band = ?`);

  const hydrateSql = `
    SELECT s.s AS s, p.s AS p, o.s AS o, COALESCE(e.t,'') AS e, n.url AS url,
      CASE p.s WHEN 'capital' THEN 0 WHEN 'is' THEN 1 WHEN 'obsoletes' THEN 2 WHEN 'updates' THEN 3 WHEN 'date' THEN 4 ELSE 5 END AS rk
    FROM nodes n
    JOIN intern s ON s.id = n.sid
    JOIN intern p ON p.id = n.pid
    JOIN intern o ON o.id = n.oid
    LEFT JOIN evidence e ON e.id = n.eid`;

  function searchSql(q: string, k: number): { s: string; p: string; o: string; e: string; url: string }[] {
    const toks = queryTokens(q);
    for (const t of [q.trim(), ...toks]) {
      if (!t) continue;
      const exact = db.query(`${hydrateSql} WHERE s.s = ? COLLATE NOCASE ORDER BY rk LIMIT ?`).all(t, k) as {
        s: string; p: string; o: string; e: string; url: string;
      }[];
      if (exact.length) return exact.filter((h) => h.p !== "about" && h.p !== "date" && h.o.length <= 72);
    }
    if (!toks.length) return [];
    let ids: number[] | undefined;
    let missing = false;
    for (const t of toks) {
      const row = getLex.get(t) as { id: number } | null;
      if (!row) {
        missing = true;
        break;
      }
      const nids = db.query(`SELECT nid FROM post WHERE tid = ?`).all(row.id) as { nid: number }[];
      const set = new Set(nids.map((x) => x.nid));
      ids = ids ? ids.filter((i) => set.has(i)) : [...set];
    }
    if (!missing && ids?.length) {
      const one = db.query(`${hydrateSql} WHERE n.id = ?`);
      const out: { s: string; p: string; o: string; e: string; url: string; rk: number }[] = [];
      for (const id of ids) {
        const row = one.get(id) as { s: string; p: string; o: string; e: string; url: string; rk: number } | null;
        if (row && row.p !== "about" && row.p !== "date" && row.o.length <= 72) out.push(row);
      }
      out.sort((a, b) => a.rk - b.rk);
      if (out.length) return out.slice(0, k);
    }
    return [];
  }

  return {
    db,
    dir,
    intern,
    pageDigest(url: string): string | undefined {
      const seen = db.query(`SELECT digest FROM seen_digest WHERE url = ?`).get(url) as { digest: string } | null;
      if (seen?.digest) return seen.digest;
      const row = db.query(`SELECT digest FROM pages WHERE url = ?`).get(url) as { digest: string } | null;
      return row?.digest || undefined;
    },
    hostBlocked(url: string): string | undefined {
      const h = hostOf(url);
      if (!h) return undefined;
      const row = db.query(`SELECT kept, skipped FROM host_prior WHERE host = ?`).get(h) as
        | { kept: number; skipped: number }
        | null;
      if (!row) return undefined;
      const t = row.kept + row.skipped;
      if (t >= 8 && row.kept / t < 0.15) return "host-junk";
      return undefined;
    },
    bumpHost(url: string, kept: boolean) {
      const h = hostOf(url);
      if (!h) return;
      db.run(
        `INSERT INTO host_prior(host, kept, skipped) VALUES (?,?,?)
         ON CONFLICT(host) DO UPDATE SET
           kept = kept + excluded.kept,
           skipped = skipped + excluded.skipped`,
        [h, kept ? 1 : 0, kept ? 0 : 1],
      );
    },
    nearDup(url: string, text: string): boolean {
      const bands = minhashBands(text);
      for (const b of bands) {
        const hit = getMh.get(b) as { url: string } | null;
        if (hit && hit.url !== url) return true;
      }
      for (const b of bands) insMh.run(b, url);
      const n = (db.query(`SELECT COUNT(*) AS n FROM mh_band`).get() as { n: number }).n;
      if (n > 80_000) db.run(`DELETE FROM mh_band WHERE rowid IN (SELECT rowid FROM mh_band LIMIT 8000)`);
      return false;
    },
    putPage(row: {
      url: string;
      digest: string;
      chars: number;
      source: string;
      ttl_days: number;
      skip?: string;
    }) {
      if (row.digest) {
        db.run(
          `INSERT INTO seen_digest(url, digest) VALUES (?,?)
           ON CONFLICT(url) DO UPDATE SET digest=excluded.digest`,
          [row.url, row.digest],
        );
      }
      if (row.skip) return;
      if (!qualityHost(row.url)) return;
      db.run(
        `INSERT INTO pages(url,digest,chars,source,fetched_at,ttl_days)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(url) DO UPDATE SET digest=excluded.digest, chars=excluded.chars,
           source=excluded.source, fetched_at=excluded.fetched_at, ttl_days=excluded.ttl_days`,
        [row.url, row.digest, row.chars, row.source, Date.now(), row.ttl_days],
      );
    },
    putNodes(url: string, triples: Triple[], ttl_days: number) {
      const write = db.transaction(() => {
        const now = Date.now();
        const ins = db.prepare(
          `INSERT INTO nodes(sid,pid,oid,eid,url,as_of,ttl_days) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(sid, pid) DO UPDATE SET
             oid = CASE WHEN excluded.eid != 0 AND nodes.eid = 0 THEN excluded.oid
                        WHEN nodes.eid = 0 THEN excluded.oid ELSE nodes.oid END,
             eid = CASE WHEN excluded.eid != 0 AND nodes.eid = 0 THEN excluded.eid
                        WHEN nodes.eid = 0 THEN excluded.eid ELSE nodes.eid END,
             url = CASE WHEN excluded.eid != 0 AND nodes.eid = 0 THEN excluded.url
                        WHEN nodes.eid = 0 THEN excluded.url ELSE nodes.url END,
             as_of = excluded.as_of,
             ttl_days = excluded.ttl_days`,
        );
        const insP = db.prepare(`INSERT OR IGNORE INTO post(tid, nid) VALUES (?,?)`);
        const delPost = db.prepare(`DELETE FROM post WHERE nid = ?`);
        const getNid = db.prepare(`SELECT id FROM nodes WHERE sid = ? AND pid = ?`);
        const keepEv = new Set(["capital", "is", "obsoletes", "updates"]);
        const keep = new Set<string>();
        for (const t of triples) {
          if (!persistable(url, t)) continue;
          if (t.o.length > 72 || /\b(Light|Dark|Auto)\b/i.test(t.o) || /REP\)/i.test(t.o)) continue;
          const sid = intern(t.s);
          const pid = intern(t.p);
          const oid = intern(t.o);
          const eid = casEvidence(keepEv.has(t.p) ? t.e : "");
          ins.run(sid, pid, oid, eid, url, now, ttl_days);
          const nid = (getNid.get(sid, pid) as { id: number }).id;
          keep.add(`${sid},${pid}`);
          delPost.run(nid);
          const words = catalogSubject(t.s) ? catalogAliasKeys(t) : indexTokens(t);
          for (const w of words) insP.run(lex(w), nid);
        }
        const stale = db
          .query(`SELECT id, sid, pid FROM nodes WHERE url = ?`)
          .all(url) as { id: number; sid: number; pid: number }[];
        for (const r of stale) {
          if (keep.has(`${r.sid},${r.pid}`)) continue;
          delPost.run(r.id);
          db.run(`DELETE FROM nodes WHERE id = ?`, [r.id]);
        }
      });
      write();
    },
    enqueue(urls: string[], from: string) {
      const now = Date.now();
      const ins = db.prepare(
        `INSERT OR IGNORE INTO frontier(url, next_fetch, from_url) VALUES (?,?,?)`,
      );
      for (const u of urls) {
        if (from !== "seed" && !qualityHost(u)) continue;
        if (from !== "seed" && /image-article|\bapod\b/i.test(u)) continue;
        ins.run(u, now, from);
      }
      trimFrontier(db);
    },
    takeFrontier(n: number): string[] {
      const rows = db
        .query(
          `SELECT url FROM frontier WHERE next_fetch <= ?
           ORDER BY ${FRONTIER_RANK_SQL}, next_fetch
           LIMIT ?`,
        )
        .all(Date.now(), n) as { url: string }[];
      const del = db.prepare(`DELETE FROM frontier WHERE url = ?`);
      for (const r of rows) del.run(r.url);
      return rows.map((r) => r.url);
    },
    count() {
      const pages = (db.query(`SELECT COUNT(*) AS n FROM pages`).get() as { n: number }).n;
      const skipped = (db.query(`SELECT COALESCE(SUM(skipped),0) AS n FROM host_prior`).get() as { n: number }).n;
      const walNodes = (db.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n;
      const frontier = (db.query(`SELECT COUNT(*) AS n FROM frontier`).get() as { n: number }).n;
      const packed = pack?.nTriples ?? 0;
      return { pages, skipped, nodes: walNodes + packed, frontier, wal_nodes: walNodes, pack: packed };
    },
    search(q: string, k = 5): { s: string; p: string; o: string; e: string; url: string }[] {
      const overlay = searchSql(q, k);
      if (!pack) return overlay;
      if (!overlay.length) return pack.search(q, k);
      const keys = new Set(overlay.map((h) => `${h.s}\0${h.p}`));
      const rest = pack.search(q, k).filter((h) => !keys.has(`${h.s}\0${h.p}`));
      const rk = (p: string) =>
        p === "capital" ? 0 : p === "is" ? 1 : p === "obsoletes" ? 2 : p === "updates" ? 3 : 4;
      return [...overlay, ...rest].sort((a, b) => rk(a.p) - rk(b.p)).slice(0, k);
    },
    expire(now = Date.now()) {
      db.run(`UPDATE nodes SET eid = 0 WHERE as_of + ttl_days * 86400000 < ? AND eid != 0`, [now]);
      db.run(`DELETE FROM evidence WHERE id NOT IN (SELECT eid FROM nodes WHERE eid != 0)`);
    },
    compact() {
      try {
        crushFrontier(db);
        trimFrontier(db);
        const overlay = db
          .query(
            `SELECT s.s AS s, p.s AS p, o.s AS o, COALESCE(e.t,'') AS e, COALESCE(n.url,'') AS url
             FROM nodes n
             JOIN intern s ON s.id = n.sid
             JOIN intern p ON p.id = n.pid
             JOIN intern o ON o.id = n.oid
             LEFT JOIN evidence e ON e.id = n.eid`,
          )
          .all() as PackFact[];
        const facts = mergeFacts(pack, overlay);
        if (facts.length) {
          const bytes = encodePack(facts);
          const decoded = decodePack(bytes);
          const tmp = `${packPath}.tmp`;
          writeFileSync(tmp, bytes);
          renameSync(tmp, packPath);
          pack = decoded;
        }
        db.run(`DELETE FROM post`);
        db.run(`DELETE FROM lex`);
        db.run(`DELETE FROM nodes`);
        db.run(`DELETE FROM intern`);
        db.run(`DELETE FROM evidence`);
        internCache.clear();
        lexCache.clear();
        db.run(`DELETE FROM mh_band`);
      } catch (e) {
        console.error(JSON.stringify({ compact: "failed", err: String(e).slice(0, 200) }));
        return;
      }
      try {
        db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
      } catch {
        /* */
      }
      db.exec(`VACUUM`);
    },
    schemaVersion(): number {
      return Number((db.query(`PRAGMA user_version`).get() as { user_version: number }).user_version);
    },
    setMeta(k: string, v: string) {
      db.run(`INSERT INTO meta(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [k, v]);
    },
    getMeta(k: string): string | undefined {
      const row = db.query(`SELECT v FROM meta WHERE k = ?`).get(k) as { v: string } | null;
      return row?.v;
    },
    close() {
      db.close();
    },
  };
}
