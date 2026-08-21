"use client";

import { useEffect, useRef } from "react";

const SHEETS = 8;
const KEEP = SHEETS - 1;
const PEEL_PX = 64;
const BLOOM_MS = 900;
const HOLD_MS = 580;
const SHED_MS = 1080;
const STAGGER_MS = 95;
const BIND_AT = BLOOM_MS;
const DONE_AT = BLOOM_MS + HOLD_MS + (SHEETS - 2) * STAGGER_MS + SHED_MS + 240;
const BLOOM = [
  { x: -136, y: 28, r: -20 },
  { x: -112, y: -74, r: -15 },
  { x: -50, y: -128, r: -8 },
  { x: 50, y: -130, r: 8 },
  { x: 114, y: -72, r: 15 },
  { x: 138, y: 30, r: 20 },
  { x: 0, y: 96, r: 3 },
] as const;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function easeOutQuart(t: number) {
  return 1 - (1 - t) ** 4;
}

type Mode = "idle" | "compiling" | "compiled";

type SheetState = {
  x: number;
  y: number;
  r: number;
  op: number;
  vx: number;
  vy: number;
  peeled: boolean;
  flying: boolean;
  fromX: number;
  fromY: number;
  fromR: number;
};

function makeSheets(): SheetState[] {
  return Array.from({ length: SHEETS }, (_, i) => ({
    x: i * 8,
    y: i * 8,
    r: (i - 2.5) * 0.8,
    op: 1,
    vx: 0,
    vy: 0,
    peeled: false,
    flying: false,
    fromX: i * 8,
    fromY: i * 8,
    fromR: (i - 2.5) * 0.8,
  }));
}

function stackedCount(sheets: SheetState[]) {
  return sheets.filter((s) => !s.flying).length;
}

function Document() {
  return (
    <>
      <span className="doc-bind" />
      <span className="doc-ear" />
      <span className="doc-head">
        <span className="doc-badge" />
        <span className="doc-name" />
      </span>
      <span className="doc-meta">
        <span />
        <span />
      </span>
      <span className="doc-sep" />
      <span className="doc-lines">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    </>
  );
}

export function LandingStage() {
  const boxRef = useRef<HTMLButtonElement>(null);
  const padRef = useRef<HTMLSpanElement>(null);
  const useBtnRef = useRef<HTMLButtonElement>(null);
  const liveRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    const pad = padRef.current;
    const useBtn = useBtnRef.current;
    const live = liveRef.current;
    if (!box || !pad || !useBtn || !live) return;
    const stage = box;
    const surface = pad;

    const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const nodes = [...surface.querySelectorAll<HTMLElement>(".sheet")];
    const sheets = makeSheets();
    let frame = 0;
    let ticking = false;
    let alive = true;
    let px = 0;
    let py = 0;
    let lastPx = 0;
    let lastPy = 0;
    let pointerIn = false;
    let pressed = false;
    let moved = false;
    let downX = 0;
    let downY = 0;
    let grabbed = -1;
    let fan = 0.2;
    let angle = Math.PI * 0.82;
    let tiltX = 0;
    let tiltY = 0;
    let mode: Mode = "idle";
    let compileAt = 0;

    const local = (rect: DOMRect) => ({
      x: px - rect.left - rect.width / 2,
      y: py - rect.top - rect.height / 2,
    });

    const topStacked = () => {
      for (let i = SHEETS - 1; i >= 0; i -= 1) {
        if (!sheets[i]!.flying) return i;
      }
      return -1;
    };

    const poseCompiled = () => {
      sheets.forEach((s, i) => {
        s.flying = false;
        s.peeled = false;
        s.vx = 0;
        s.vy = 0;
        s.r = 0;
        if (i === KEEP) {
          s.x = 0;
          s.y = 0;
          s.op = 1;
        } else {
          s.x = 0;
          s.y = 18;
          s.op = 0;
        }
      });
    };

    const setMode = (next: Mode) => {
      mode = next;
      const on = next !== "idle";
      useBtn.classList.toggle("is-on", on);
      useBtn.setAttribute("aria-pressed", on ? "true" : "false");
      useBtn.setAttribute("aria-busy", next === "compiling" ? "true" : "false");
      surface.classList.toggle("is-compiled", next === "compiled");
      stage.classList.toggle("is-locked", on);
      live.textContent =
        next === "compiling"
          ? "Clearing repeated copies. One remains."
          : next === "compiled"
            ? "Repeated copies cleared. One document remains."
            : "Copies restored.";
    };

    const startCompile = () => {
      if (mode === "compiling") return;
      if (mode === "compiled") {
        setMode("idle");
        nodes.forEach((node) => node.classList.remove("is-one"));
        kick();
        return;
      }
      pressed = false;
      grabbed = -1;
      stage.classList.remove("is-grabbing");
      sheets.forEach((s) => {
        s.flying = false;
        s.peeled = false;
        s.vx = 0;
        s.vy = 0;
        s.fromX = s.x;
        s.fromY = s.y;
        s.fromR = s.r;
        s.op = Math.max(s.op, 0.9);
      });
      if (reduceMq.matches) {
        poseCompiled();
        nodes[KEEP]?.classList.add("is-one");
        setMode("compiled");
        kick();
        return;
      }
      compileAt = performance.now();
      setMode("compiling");
      kick();
    };

    const flick = (index: number, speedX: number, speedY: number) => {
      if (mode !== "idle") return;
      const s = sheets[index];
      if (!s || s.flying) return;
      s.peeled = false;
      s.flying = true;
      s.vx = speedX;
      s.vy = speedY;
      s.op = 1;
      if (stackedCount(sheets) === 0) {
        sheets.forEach((other, i) => {
          if (i === index) return;
          other.flying = false;
          other.peeled = false;
          other.op = 0;
          other.vx = 0;
          other.vy = 0;
          other.x = 0;
          other.y = 18;
          other.r = 0;
        });
      }
    };

    const onMove = (event: PointerEvent) => {
      lastPx = px;
      lastPy = py;
      px = event.clientX;
      py = event.clientY;
      if (pointerIn || pressed) kick();
      if (!pressed || mode !== "idle") return;
      if (Math.hypot(px - downX, py - downY) > 8) {
        moved = true;
        if (grabbed >= 0 && sheets[grabbed] && !sheets[grabbed]!.flying) {
          sheets[grabbed]!.peeled = true;
        }
      }
    };
    const onEnter = () => {
      pointerIn = true;
      kick();
    };
    const onLeave = () => {
      if (!pressed) pointerIn = false;
      kick();
    };
    const onDown = (event: PointerEvent) => {
      if (mode !== "idle") return;
      event.preventDefault();
      pressed = true;
      moved = false;
      downX = event.clientX;
      downY = event.clientY;
      px = event.clientX;
      py = event.clientY;
      pointerIn = true;
      grabbed = topStacked();
      stage.setPointerCapture(event.pointerId);
      stage.classList.add("is-grabbing");
      kick();
    };
    const onUp = () => {
      if (mode !== "idle") {
        pressed = false;
        grabbed = -1;
        stage.classList.remove("is-grabbing");
        return;
      }
      const s = grabbed >= 0 ? sheets[grabbed] : null;
      const speedX = (px - lastPx) * 1.6;
      const speedY = (py - lastPy) * 1.6;
      if (s && !s.flying) {
        const dist = Math.hypot(s.x, s.y);
        if (!moved) {
          flick(grabbed, 9, 6);
        } else if (dist > PEEL_PX || Math.hypot(speedX, speedY) > 10) {
          flick(grabbed, speedX || Math.sign(s.x) * 8, speedY || Math.sign(s.y) * 6);
        } else {
          s.peeled = false;
        }
      }
      pressed = false;
      grabbed = -1;
      stage.classList.remove("is-grabbing");
      kick();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== " " && event.key !== "Enter") return;
      if (mode !== "idle") return;
      event.preventDefault();
      const top = topStacked();
      if (top >= 0) flick(top, 10, 7);
      kick();
    };

    const restFan = () => (mode === "idle" ? 0.22 : 0.08);

    const settled = () => {
      if (!alive) return true;
      if (mode === "compiling") return false;
      if (document.hidden) return true;
      if (pressed || grabbed >= 0) return false;
      if (sheets.some((s) => s.flying || s.peeled)) return false;
      if (mode === "idle" && pointerIn) return false;
      if (Math.abs(fan - restFan()) > 0.012) return false;
      if (Math.abs(tiltX) > 0.04 || Math.abs(tiltY) > 0.04) return false;
      if (mode === "idle" && sheets.some((s) => !s.flying && s.op < 0.98)) return false;
      return true;
    };

    function kick() {
      if (!alive || ticking) return;
      ticking = true;
      frame = requestAnimationFrame(draw);
    }

    const onVis = () => {
      if (!document.hidden) kick();
    };

    const onReduce = () => {
      pressed = false;
      grabbed = -1;
      stage.classList.remove("is-grabbing");
      if (reduceMq.matches && mode === "compiling") {
        poseCompiled();
        nodes[KEEP]?.classList.add("is-one");
        setMode("compiled");
      }
      kick();
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    stage.addEventListener("pointerenter", onEnter);
    stage.addEventListener("pointerleave", onLeave);
    stage.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    stage.addEventListener("keydown", onKey);
    useBtn.addEventListener("click", startCompile);
    document.addEventListener("visibilitychange", onVis);
    reduceMq.addEventListener("change", onReduce);

    function draw() {
      if (!alive) {
        ticking = false;
        return;
      }
      const reduce = reduceMq.matches;
      const rect = stage.getBoundingClientRect();
      const p = local(rect);
      const over =
        mode === "idle" &&
        pointerIn &&
        px >= rect.left &&
        px <= rect.right &&
        py >= rect.top &&
        py <= rect.bottom;
      const tFan = over ? 0.46 : restFan();
      const tTiltY = over ? clamp((p.x / Math.max(rect.width, 1)) * 2.4, -3.2, 3.2) : 0;
      const tTiltX = over ? clamp((-p.y / Math.max(rect.height, 1)) * 1.8, -2.4, 2.4) : 0;
      const now = performance.now();
      const elapsed = now - compileAt;

      if (reduce || mode !== "idle") {
        fan += (0.08 - fan) * 0.2;
        angle += (Math.PI * 0.82 - angle) * 0.16;
        tiltX += (0 - tiltX) * 0.2;
        tiltY += (0 - tiltY) * 0.2;
      } else {
        fan += (tFan - fan) * 0.1;
        angle += (Math.PI * 0.82 - angle) * 0.1;
        tiltY += (tTiltY - tiltY) * 0.1;
        tiltX += (tTiltX - tiltX) * 0.1;
      }

      const bound = mode === "compiled" || (mode === "compiling" && elapsed >= BIND_AT);
      let k = 0;
      const n = stackedCount(sheets);

      for (let i = 0; i < SHEETS; i += 1) {
        const s = sheets[i]!;
        const node = nodes[i];
        if (!node) continue;

        if (mode === "compiling" || mode === "compiled") {
          const keep = i === KEEP;
          const petal = BLOOM[i];
          const shedAt = BLOOM_MS + HOLD_MS;

          if (mode === "compiled") {
            s.x = 0;
            s.y = 0;
            s.r = 0;
            s.op = keep ? 1 : 0;
            node.style.filter = "none";
          } else if (keep) {
            const u = easeOutQuart(clamp(elapsed / BLOOM_MS, 0, 1));
            s.x = lerp(s.fromX, 0, u);
            s.y = lerp(s.fromY, 0, u);
            s.r = lerp(s.fromR, 0, u);
            s.op = 1;
            node.style.filter = "none";
          } else if (elapsed < BLOOM_MS) {
            const u = easeOutQuart(elapsed / BLOOM_MS);
            s.x = lerp(s.fromX, petal?.x ?? 0, u);
            s.y = lerp(s.fromY, petal?.y ?? 0, u);
            s.r = lerp(s.fromR, petal?.r ?? 0, u);
            s.op = 1;
            node.style.filter = "none";
          } else if (elapsed < shedAt) {
            s.x = petal?.x ?? 0;
            s.y = petal?.y ?? 0;
            s.r = petal?.r ?? 0;
            s.op = 1;
            node.style.filter = "none";
          } else {
            const order = KEEP - 1 - i;
            const localMs = elapsed - shedAt - order * STAGGER_MS;
            const bx = petal?.x ?? 0;
            const by = petal?.y ?? 0;
            const br = petal?.r ?? 0;
            if (localMs <= 0) {
              s.x = bx;
              s.y = by;
              s.r = br;
              s.op = 1;
              node.style.filter = "none";
            } else {
              const u = easeOutQuart(clamp(localMs / SHED_MS, 0, 1));
              s.x = bx * (1 + 2.6 * u);
              s.y = by * (1 + 2.6 * u);
              s.r = br * (1 + 0.8 * u);
              s.op = 1 - u * u;
              node.style.filter = "none";
            }
          }

          const order = KEEP - 1 - i;
          const localMs = elapsed - BLOOM_MS - HOLD_MS - order * STAGGER_MS;
          const shedding = !keep && elapsed >= BLOOM_MS + HOLD_MS && localMs > 0;
          const sc = shedding ? lerp(1, 0.5, clamp(localMs / SHED_MS, 0, 1)) : keep ? 1.02 : 1;
          node.classList.toggle("is-top", false);
          node.classList.toggle("is-one", keep && bound);
          node.classList.toggle("is-held", false);
          node.style.opacity = s.op.toFixed(3);
          node.style.zIndex = String(keep ? 50 : shedding ? 30 + i : 12 + i);
          node.style.transform = `translate3d(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px, ${keep ? 32 : 8 + i}px) rotate(${s.r.toFixed(2)}deg) scale(${sc.toFixed(3)})`;
          continue;
        }

        if (s.flying) {
          if (reduce) {
            s.flying = false;
            s.op = 0;
            s.x = 0;
            s.y = 18;
          } else {
            s.x += s.vx;
            s.y += s.vy;
            s.r += s.vx * 0.04;
            s.vx *= 0.985;
            s.vy = s.vy * 0.985 + 0.32;
            s.op *= 0.94;
            if (s.op < 0.08 || Math.hypot(s.x, s.y) > 420) {
              s.flying = false;
              s.op = 0;
              s.vx = 0;
              s.vy = 0;
              s.x = 0;
              s.y = 18;
              s.r = 0;
            }
          }
          node.classList.toggle("is-top", false);
          node.classList.toggle("is-one", false);
        } else if (s.peeled) {
          s.x += (p.x - s.x) * 0.38;
          s.y += (p.y - s.y) * 0.38;
          s.r += (p.x * 0.03 - s.r) * 0.2;
          s.op = 1;
          node.classList.toggle("is-top", false);
          node.classList.toggle("is-one", false);
        } else {
          const carbon = k * 8;
          const step = 15;
          const tx = Math.cos(angle) * k * step * fan + (1 - fan) * carbon;
          const ty = Math.sin(angle) * k * step * fan + (1 - fan) * carbon;
          const tr = (k - Math.max(n - 1, 1) / 2) * 2.4 * fan;
          const liftTop = over && k === n - 1 && !pressed ? 1 : 0;
          const rx = liftTop * clamp(p.x * 0.035, -12, 12);
          const ry = liftTop * clamp(p.y * 0.028, -9, 9);
          s.x += (tx + rx - s.x) * 0.18;
          s.y += (ty + ry - 6 * liftTop - s.y) * 0.18;
          s.r += (tr + liftTop * clamp(p.x * 0.012, -3, 3) - s.r) * 0.16;
          s.op += (1 - s.op) * 0.18;
          node.classList.toggle("is-top", liftTop === 1);
          node.classList.toggle("is-one", false);
          k += 1;
        }

        node.classList.toggle("is-held", s.peeled);
        node.style.filter = "none";
        node.style.opacity = s.op.toFixed(3);
        node.style.zIndex = String(s.peeled || s.flying ? 40 : i + 1);
        node.style.transform = `translate3d(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px, ${s.peeled ? 24 : k}px) rotate(${s.r.toFixed(2)}deg)`;
      }

      if (mode === "compiling" && elapsed >= DONE_AT) {
        poseCompiled();
        setMode("compiled");
      }

      const padX = mode === "idle" ? 3.5 + tiltX : 0;
      const padY = mode === "idle" ? -6 + tiltY : 0;
      surface.style.transform = `rotateX(${padX.toFixed(2)}deg) rotateY(${padY.toFixed(2)}deg)`;
      if (settled()) {
        ticking = false;
        return;
      }
      frame = requestAnimationFrame(draw);
    };

    kick();

    return () => {
      alive = false;
      ticking = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerenter", onEnter);
      stage.removeEventListener("pointerleave", onLeave);
      stage.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      stage.removeEventListener("keydown", onKey);
      useBtn.removeEventListener("click", startCompile);
      document.removeEventListener("visibilitychange", onVis);
      reduceMq.removeEventListener("change", onReduce);
    };
  }, []);

  return (
    <div className="abstract-slot">
      <button
        ref={boxRef}
        className="abstract"
        type="button"
        aria-label="Move over the copies to riffle them. Click or throw a sheet to abstract it."
      >
        <span className="pad" ref={padRef} aria-hidden="true">
          {Array.from({ length: SHEETS }, (_, i) => (
            <span key={i} className="sheet">
              <Document />
            </span>
          ))}
        </span>
      </button>
      <button
        ref={useBtnRef}
        className="use-eden"
        type="button"
        aria-pressed="false"
        aria-busy="false"
        aria-label="Use Eden to clear repeated copies and leave one"
      >
        Use Eden
      </button>
      <span className="sr-only" ref={liveRef} aria-live="polite" />
    </div>
  );
}
