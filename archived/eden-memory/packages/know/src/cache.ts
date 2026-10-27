import { statSync } from "node:fs";
import { join } from "node:path";
import { knowDir, openQueryStore, type KnowSearch } from "./store";
import { PACK_FILE } from "./pack";
import { remoteKnowSearch, shardForQuery } from "./route";

type Hold = { dir: string; mtime: number; store: KnowSearch; url: string };

let hold: Hold | null = null;

function packMtime(dir: string): number {
  try {
    return statSync(join(dir, PACK_FILE)).mtimeMs;
  } catch {
    return 0;
  }
}

function localStore(dir: string): KnowSearch {
  let inner: KnowSearch | null = null;
  return {
    search(q, k) {
      if (!inner) inner = openQueryStore(dir);
      return inner.search(q, k);
    },
    close() {
      try {
        inner?.close?.();
      } catch {
        /* */
      }
      inner = null;
    },
  };
}

function withRemote(local: KnowSearch, url: string): KnowSearch {
  const remote = remoteKnowSearch(url);
  return {
    search(q, k) {
      const hits = local.search(q, k);
      if (hits.length || shardForQuery(q) === "hot") return hits;
      return remote.search(q, k);
    },
    close() {
      local.close?.();
    },
  };
}

/** Process-local pack. Decode on first search so synth flash never pays 33 ms. */
export function sharedStore(): KnowSearch {
  const dir = knowDir();
  const mtime = packMtime(dir);
  const url = process.env.EDEN_KNOW_URL || "";
  if (hold && hold.dir === dir && hold.mtime === mtime && hold.url === url) return hold.store;
  try {
    hold?.store.close?.();
  } catch {
    /* */
  }
  const local = localStore(dir);
  const store = url ? withRemote(local, url) : local;
  hold = { dir, mtime, store, url };
  return store;
}

export function dropSharedStore() {
  try {
    hold?.store.close?.();
  } catch {
    /* */
  }
  hold = null;
}
