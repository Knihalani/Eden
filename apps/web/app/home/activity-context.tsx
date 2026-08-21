"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { EMPTY_ACTIVITY, failedActivity, type Activity } from "./activity";

export type ActivityView = Activity & { ready: boolean };

const ACTIVITY_CACHE = "eden:activity:v2";
const ACTIVITY_EVENT = "eden:activity";

type CachedActivity = { owner: string; etag: string; activity: Activity };

function readActivityCache(owner: string): CachedActivity | null {
  if (!owner || typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(ACTIVITY_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedActivity;
    if (!parsed?.activity || typeof parsed.activity !== "object") return null;
    if (parsed.owner !== owner) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeActivityCache(owner: string, etag: string, activity: Activity) {
  try {
    const payload: CachedActivity = { owner, etag, activity };
    sessionStorage.setItem(ACTIVITY_CACHE, JSON.stringify(payload));
  } catch {
    /* quota */
  }
}

export function forgetActivity() {
  try {
    sessionStorage.removeItem(ACTIVITY_CACHE);
  } catch {
    /* missing storage */
  }
}

export function pokeActivity() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ACTIVITY_EVENT));
}

const ActivityContext = createContext<ActivityView>({ ...EMPTY_ACTIVITY, ready: false });

export function useActivity() {
  return useContext(ActivityContext);
}

function asView(activity: Activity, ready: boolean): ActivityView {
  return {
    runs: activity.runs ?? 0,
    compiled: activity.compiled ?? 0,
    waiting: activity.waiting ?? 0,
    fails: activity.fails ?? 0,
    llmTimes: activity.llmTimes ?? 0,
    tokensSaved: activity.tokensSaved ?? 0,
    failed: Boolean(activity.failed),
    series: Array.isArray(activity.series) ? [...activity.series] : [],
    workflows: Array.isArray(activity.workflows) ? [...activity.workflows] : [],
    requests: Array.isArray(activity.requests) ? [...activity.requests] : [],
    ready,
  };
}

export function ActivityProvider({
  initial,
  owner,
  quiet,
  children,
}: {
  initial: Activity;
  owner: string;
  quiet?: boolean;
  children: ReactNode;
}) {
  const [activity, setActivity] = useState<ActivityView>(() => asView(initial, false));
  const etag = useRef("");
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

  useLayoutEffect(() => {
    const cached = readActivityCache(owner);
    if (cached) {
      etag.current = cached.etag;
      setActivity(asView(cached.activity, true));
    }
  }, [owner]);

  useEffect(() => {
    if (quiet || !owner) return;
    let alive = true;
    const pull = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const headers: HeadersInit = etag.current ? { "if-none-match": etag.current } : {};
        const res = await fetch("/api/activity", { cache: "no-store", headers });
        if (!alive) return;
        if (res.status === 401) {
          forgetActivity();
          etag.current = "";
          setActivity(asView(failedActivity(), true));
          return;
        }
        if (res.status === 304) return;
        const nextTag = res.headers.get("etag");
        if (nextTag) etag.current = nextTag;
        if (!res.ok) {
          setActivity((cur) => (cur.ready && !cur.failed ? cur : asView(failedActivity(), true)));
          return;
        }
        const next = (await res.json()) as Activity;
        if (!ownerRef.current) return;
        writeActivityCache(ownerRef.current, etag.current, next);
        setActivity(asView(next, true));
      } catch {
        setActivity((cur) => (cur.ready && !cur.failed ? cur : asView(failedActivity(), true)));
      }
    };
    const cached = readActivityCache(owner);
    const start = window.setTimeout(() => void pull(), cached ? 600 : 0);
    const timer = window.setInterval(() => void pull(), 8000);
    document.addEventListener("visibilitychange", pull);
    window.addEventListener(ACTIVITY_EVENT, pull);
    return () => {
      alive = false;
      window.clearTimeout(start);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", pull);
      window.removeEventListener(ACTIVITY_EVENT, pull);
    };
  }, [owner, quiet]);

  return <ActivityContext.Provider value={activity}>{children}</ActivityContext.Provider>;
}
