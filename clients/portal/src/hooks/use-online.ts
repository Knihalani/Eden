"use client";

import { useEffect, useState } from "react";

/**
 * ui-audit prompt 82: returns `true` when the browser reports
 * an active network connection. Updates live on `online`/`offline`
 * events. SSR-safe (defaults to true so server-rendered pages
 * don't show an offline flash on hydration).
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    setOnline(typeof navigator !== "undefined" ? navigator.onLine : true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return online;
}
