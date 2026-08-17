import { useCallback, useEffect, useState } from "react";
import { getInbox } from "./api";
import type { Inbox } from "./types";

export function useInbox(ms = 4000) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    try {
      const next = await getInbox();
      setInbox((prev) => (prev?.sig === next.sig ? prev : next));
      setErr("");
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), ms);
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load, ms]);

  return { inbox, err, setErr, load };
}
