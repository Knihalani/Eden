"use client";

import { type ReactNode, useEffect, useRef } from "react";

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function LandingPin({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = ref.current;
    if (!track) return;

    const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const root = document.documentElement;
    const bar = document.getElementById("convert");
    let frame = 0;
    let ticking = false;
    let total = 1;
    let lastWipe = "";
    let lastSoon = "";
    let lastConv = "";
    let lastBusy = "";
    let lastStory = "";
    let lastOn: boolean | null = null;

    const measure = () => {
      total = Math.max(track.offsetHeight - window.innerHeight, 1);
    };

    const write = (node: HTMLElement, name: string, next: string, prev: string) => {
      if (next === prev) return prev;
      node.style.setProperty(name, next);
      return next;
    };

    const applyBar = (on: boolean) => {
      if (lastOn === on) return;
      lastOn = on;
      root.classList.toggle("is-converting", on);
      const promise = track.querySelector(".promise");
      if (promise instanceof HTMLElement) promise.inert = on;
      if (!bar) return;
      bar.setAttribute("aria-hidden", on ? "false" : "true");
      bar.inert = !on;
    };

    const poseReduced = () => {
      lastWipe = write(track, "--wipe", "0", "");
      lastSoon = write(track, "--beat-soon", "1", "");
      lastConv = write(root, "--beat-convert", "1", "");
      lastBusy = "0";
      lastStory = "1";
      lastOn = null;
      track.dataset.busy = "0";
      track.dataset.story = "1";
      applyBar(true);
    };

    const sync = () => {
      ticking = false;
      if (reduceMq.matches) {
        poseReduced();
        return;
      }

      const pin = clamp(-track.getBoundingClientRect().top / total, 0, 1);
      const wipe = smoothstep(0.05, 0.48, pin);
      const soon = smoothstep(0.5, 0.66, pin);
      const conv = smoothstep(0.7, 0.9, pin);

      lastWipe = write(track, "--wipe", wipe.toFixed(3), lastWipe);
      lastSoon = write(track, "--beat-soon", soon.toFixed(3), lastSoon);
      lastConv = write(root, "--beat-convert", conv.toFixed(3), lastConv);

      const busy = wipe > 0.02 && wipe < 0.98 ? "1" : "0";
      if (busy !== lastBusy) {
        lastBusy = busy;
        track.dataset.busy = busy;
      }
      const story = wipe > 0.1 ? "1" : "0";
      if (story !== lastStory) {
        lastStory = story;
        track.dataset.story = story;
      }
      applyBar(conv > 0.5);
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      frame = requestAnimationFrame(sync);
    };

    const onResize = () => {
      measure();
      onScroll();
    };

    measure();
    sync();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    reduceMq.addEventListener("change", sync);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      reduceMq.removeEventListener("change", sync);
      root.classList.remove("is-converting");
      root.style.removeProperty("--beat-convert");
    };
  }, []);

  return (
    <div ref={ref} className="hero-pin" data-busy="0" data-story="0">
      {children}
    </div>
  );
}
