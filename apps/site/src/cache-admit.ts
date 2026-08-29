/**
 * Write admission for the exact-result cache.
 *
 * W-TinyLFU's idea ( TinyLFU paper + Caffeine wiki ): a frequency sketch
 * rejects one-shot / scan traffic so it does not pollute the main space, and
 * a small admission window lets *new* keys in long enough that a true repeat
 * can prove itself. We are a write-through SQLite cache with TTL eviction,
 * not an in-RAM SLRU — so the sketch gates **whether we INSERT**, not which
 * RAM victim to keep.
 *
 * - Doorkeeper: the first sight of a key does not increment the Count-Min
 *   sketch (scan traffic never looks frequent).
 * - Window: first-seen keys still persist up to a small cap, so a compiled
 *   GET that will be replayed on the next run is not forced to miss twice.
 * - Frequency bypass: once the sketch predicts a repeat, the window cap
 *   does not apply — unique storms stay out; repeating keys enter even after
 *   the window is full.
 *
 * Mutating HTTP methods are refused here too: frequency must never be an
 * excuse to cache a POST.
 */

export const ADMISSION_WINDOW_CAP = 64;

const CMS_DEPTH = 4;
const CMS_WIDTH = 4096;
const CMS_AGE_EVERY = 32_768;
const DOORKEEPER_CAP = 8192;

const counters = new Uint16Array(CMS_DEPTH * CMS_WIDTH);
const doorkeeper = new Set<string>();
/**
 * Probation windows, one per workspace. Cache *keys* already hash the
 * workspace, but a global 64-key window would let tenant A's unique-GET
 * storm fill the cap and refuse tenant B's first real repeats. Missing
 * workspace (tests, force-refresh) shares the empty-string bucket.
 */
const windows = new Map<string, Map<string, true>>();

let adds = 0;
let admitted = 0;
let rejected = 0;

function hash32(key: string, seed: number): number {
  // FNV-1a with a seed mix — fast, no crypto, good enough for a sketch.
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

function estimate(key: string): number {
  let min = 0xffff;
  const h1 = hash32(key, 0x9e3779b9);
  const h2 = hash32(key, 0x85ebca6b) | 1;
  for (let d = 0; d < CMS_DEPTH; d++) {
    const idx = d * CMS_WIDTH + ((h1 + d * h2) >>> 0) % CMS_WIDTH;
    const v = counters[idx]!;
    if (v < min) min = v;
  }
  return min === 0xffff ? 0 : min;
}

function increment(key: string): void {
  const h1 = hash32(key, 0x9e3779b9);
  const h2 = hash32(key, 0x85ebca6b) | 1;
  for (let d = 0; d < CMS_DEPTH; d++) {
    const idx = d * CMS_WIDTH + ((h1 + d * h2) >>> 0) % CMS_WIDTH;
    const v = counters[idx]!;
    if (v < 0xfffe) counters[idx] = (v + 1) as number;
  }
  adds++;
  if (adds % CMS_AGE_EVERY === 0) age();
}

function age(): void {
  for (let i = 0; i < counters.length; i++) counters[i] = counters[i]! >>> 1;
  doorkeeper.clear();
}

/**
 * Record an access. First sight only sets the doorkeeper (estimate stays 0).
 * Later sights increment the sketch. Returns the post-observe estimate.
 */
export function observeCacheKey(key: string): number {
  if (!doorkeeper.has(key)) {
    if (doorkeeper.size >= DOORKEEPER_CAP) doorkeeper.clear();
    doorkeeper.add(key);
    return estimate(key);
  }
  increment(key);
  return estimate(key);
}

function scopeOf(workspaceId?: string): string {
  return workspaceId && workspaceId.length > 0 ? workspaceId : "";
}

function windowFor(scope: string): Map<string, true> {
  let w = windows.get(scope);
  if (!w) {
    w = new Map();
    windows.set(scope, w);
  }
  return w;
}

function windowAdmit(key: string, workspaceId?: string): boolean {
  const windowKeys = windowFor(scopeOf(workspaceId));
  if (windowKeys.has(key)) return true;
  if (windowKeys.size < ADMISSION_WINDOW_CAP) {
    windowKeys.set(key, true);
    return true;
  }
  // Window full: TinyLFU compare against the oldest probationer. Equal
  // frequency (typical of a unique storm) keeps the incumbent — the candidate
  // is the one-shot we refuse to persist.
  const victim = windowKeys.keys().next().value as string | undefined;
  if (victim !== undefined && estimate(key) > estimate(victim)) {
    windowKeys.delete(victim);
    windowKeys.set(key, true);
    return true;
  }
  return false;
}

/**
 * True when this key should be INSERT'd. Observes the key as a side effect.
 * Predicted repeats (sketch ≥ 1 after the doorkeeper) bypass the window cap.
 * `workspaceId` partitions the probation window so one tenant's scan cannot
 * starve another tenant's first-seen compiled GETs.
 */
export function shouldAdmitWrite(key: string, workspaceId?: string): boolean {
  const freq = observeCacheKey(key);
  if (freq >= 1) return true;
  return windowAdmit(key, workspaceId);
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string | undefined): boolean {
  if (method === undefined) return false;
  return MUTATING.has(method.toUpperCase());
}

export function resetCacheAdmission(): void {
  counters.fill(0);
  doorkeeper.clear();
  windows.clear();
  adds = 0;
  admitted = 0;
  rejected = 0;
}

export function recordAdmissionDecision(wrote: boolean): void {
  if (wrote) admitted++;
  else rejected++;
}

export function admissionStats(): {
  window: number;
  sketchAdds: number;
  admitted: number;
  rejected: number;
} {
  let window = 0;
  for (const w of windows.values()) window += w.size;
  return { window, sketchAdds: adds, admitted, rejected };
}
