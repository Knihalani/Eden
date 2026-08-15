"use client";

/**
 * K15 follow-up — one-shot unregister for the deleted portal SW.
 *
 * ``public/service-worker.js`` was removed, but browsers that already
 * installed it keep controlling clients until unregister runs. Mount
 * once from the root layout so every surface (portal + marketing)
 * drops the stale controller without re-registering.
 */

import { useEffect } from "react";

const DONE_KEY = "eden:sw-unregistered-v1";

export function UnregisterServiceWorkers() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    try {
      if (window.sessionStorage.getItem(DONE_KEY) === "1") return;
    } catch {
      /* private mode / blocked storage — still attempt unregister */
    }

    void navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
      .then(() => {
        try {
          window.sessionStorage.setItem(DONE_KEY, "1");
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* ignore — offline / unsupported */
      });
  }, []);

  return null;
}
