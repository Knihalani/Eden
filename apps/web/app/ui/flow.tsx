"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { Step } from "@/app/lib/types";
import {
  detailOf,
  edgesOf,
  kindLabel,
  labelOf,
  layoutDag,
  neighbor,
  NH,
  NW,
  type NodePos,
} from "./dag-layout";

export {
  bindText,
  bindingsOf,
  detailOf,
  kindHint,
  kindLabel,
  labelOf,
  layoutDag,
  neighbor,
  verdictLabel,
} from "./dag-layout";

const GRID = 20;
const MINI_W = 128;
const MINI_H = 80;
const K_MIN = 0.35;
const K_MAX = 1.8;

export function Flow({
  steps,
  selected,
  dropped,
  islands,
  fault,
  live,
  onSelect,
}: {
  steps: Step[];
  selected?: string | null;
  dropped?: string[];
  islands?: string[];
  fault?: string | null;
  live?: boolean;
  onSelect: (id: string) => void;
}) {
  const { nodes, width, height } = useMemo(() => layoutDag(steps), [steps]);
  const pos = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const edges = useMemo(() => edgesOf(steps), [steps]);
  const byId = useMemo(() => new Map(steps.map((s) => [s.id, s])), [steps]);
  const incoming = useMemo(() => new Set(edges.map((e) => e.to)), [edges]);
  const outgoing = useMemo(() => new Set(edges.map((e) => e.from)), [edges]);
  const current = selected && pos.has(selected) ? selected : (nodes[0]?.id ?? null);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; vx: number; vy: number; lastX: number; lastY: number; lastT: number } | null>(null);
  const vel = useRef({ x: 0, y: 0 });
  const inertia = useRef<number | null>(null);
  const panRaf = useRef<number | null>(null);
  const panNext = useRef<{ x: number; y: number } | null>(null);
  const [view, setView] = useState({ x: 48, y: 48, k: 0.92 });
  const [wrapSize, setWrapSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const nodeGest = useRef<{ id: string; x: number; y: number; panned: boolean } | null>(null);
  const fittedFor = useRef("");
  const viewRef = useRef(view);
  viewRef.current = view;
  const prevNode = useRef<string | null>(null);

  function clampK(k: number) {
    return Math.min(K_MAX, Math.max(K_MIN, k));
  }

  function fit() {
    const el = wrap.current;
    if (!el) return;
    const mobile = el.clientWidth < 860;
    if (mobile) {
      const k = 0.82;
      const n = (current && pos.get(current)) || nodes[0];
      if (!n) {
        setView({ k, x: 20, y: 72 });
        return;
      }
      const top = 56;
      const bot = 52;
      setView({
        k,
        x: el.clientWidth / 2 - (n.x + NW / 2) * k,
        y: top + (el.clientHeight - top - bot) / 2 - (n.y + NH / 2) * k,
      });
      return;
    }
    const padL = 64;
    const padT = 64;
    const padB = 96;
    const padR = 304;
    const sx = (el.clientWidth - padL - padR) / Math.max(width, 1);
    const sy = (el.clientHeight - padT - padB) / Math.max(height, 1);
    const k = Math.min(1, Math.max(K_MIN, Math.min(sx, sy)));
    setView({
      k,
      x: padL + (el.clientWidth - padL - padR - width * k) / 2,
      y: padT + (el.clientHeight - padT - padB - height * k) / 2,
    });
  }

  function zoomAt(factor: number, cx?: number, cy?: number) {
    const el = wrap.current;
    if (!el) return;
    stopInertia();
    const mx = cx ?? el.clientWidth / 2;
    const my = cy ?? el.clientHeight / 2;
    setView((v) => {
      const nk = clampK(v.k * factor);
      const wx = (mx - v.x) / v.k;
      const wy = (my - v.y) / v.k;
      return { k: nk, x: mx - wx * nk, y: my - wy * nk };
    });
  }

  function stopInertia() {
    if (inertia.current != null) {
      cancelAnimationFrame(inertia.current);
      inertia.current = null;
    }
  }

  function actualSize() {
    const el = wrap.current;
    if (!el) return;
    stopInertia();
    setView((v) => {
      const cx = el.clientWidth / 2;
      const cy = el.clientHeight / 2;
      const wx = (cx - v.x) / v.k;
      const wy = (cy - v.y) / v.k;
      return { k: 1, x: cx - wx, y: cy - wy };
    });
  }

  useLayoutEffect(() => {
    const el = wrap.current;
    const key = `${width}x${height}`;
    if (!el || el.clientWidth < 8 || el.clientHeight < 8) return;
    if (fittedFor.current === key) return;
    fit();
    fittedFor.current = key;
  }, [width, height, wrapSize.w, wrapSize.h]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWrapSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setWrapSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopInertia();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        setView((v) => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }));
        return;
      }
      const rect = el.getBoundingClientRect();
      zoomAt(e.deltaY > 0 ? 0.92 : 1.09, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        fit();
      } else if (e.key === "1" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        actualSize();
      } else if ((e.key === "=" || e.key === "+") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        zoomAt(1.09);
      } else if (e.key === "-" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        zoomAt(0.92);
      } else if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        wrap.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [width, height]);

  useEffect(
    () => () => {
      stopInertia();
      if (panRaf.current != null) cancelAnimationFrame(panRaf.current);
    },
    [],
  );

  function move(dir: "left" | "right" | "up" | "down") {
    if (!current) return;
    const next = neighbor(nodes, current, dir, edges);
    if (next) onSelect(next);
  }

  function jumpTo(wx: number, wy: number) {
    const x = Math.min(width, Math.max(0, wx));
    const y = Math.min(height, Math.max(0, wy));
    setView((v) => ({
      ...v,
      x: wrapSize.w / 2 - x * v.k,
      y: wrapSize.h / 2 - y * v.k,
    }));
  }

  useEffect(() => {
    const prev = prevNode.current;
    prevNode.current = current;
    if (!prev || !current || prev === current) return;
    const n = pos.get(current);
    const el = wrap.current;
    if (!n || !el) return;
    const v = viewRef.current;
    const nx = n.x * v.k + v.x;
    const ny = n.y * v.k + v.y;
    const nw = NW * v.k;
    const nh = NH * v.k;
    const pad = 28;
    const padR = el.clientWidth < 860 ? 28 : 304;
    const padB = 96;
    let dx = 0;
    let dy = 0;
    if (nx < pad) dx = pad - nx;
    if (ny < pad) dy = pad - ny;
    if (nx + nw > el.clientWidth - padR) dx = el.clientWidth - padR - (nx + nw);
    if (ny + nh > el.clientHeight - padB) dy = el.clientHeight - padB - (ny + nh);
    if (dx || dy) setView((cur) => ({ ...cur, x: cur.x + dx, y: cur.y + dy }));
  }, [current, pos, wrapSize.w, wrapSize.h]);

  function flushPan() {
    panRaf.current = null;
    const p = panNext.current;
    if (!p) return;
    setView((v) => ({ ...v, x: p.x, y: p.y }));
  }

  const hot = hover && pos.has(hover) ? hover : current;

  return (
    <>
      <div
        className="board-scroll"
        ref={wrap}
        data-panning={panning ? "true" : "false"}
        tabIndex={0}
        aria-label="Workflow canvas"
        style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, var(--grid) 1px, transparent 0)`,
          backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            move("right");
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            move("left");
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            move("down");
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move("up");
          } else if (e.key === "Home") {
            e.preventDefault();
            if (nodes[0]) onSelect(nodes[0].id);
          } else if (e.key === "End") {
            e.preventDefault();
            const last = nodes[nodes.length - 1];
            if (last) onSelect(last.id);
          } else if (e.key === " " || e.code === "Space") {
            e.preventDefault();
            setPanning(true);
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.code === "Space") {
            if (!drag.current) setPanning(false);
          }
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest(".node")) return;
          fit();
        }}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest(".node") && !nodeGest.current?.panned) return;
          stopInertia();
          setPanning(true);
          drag.current = {
            px: e.clientX,
            py: e.clientY,
            vx: view.x,
            vy: view.y,
            lastX: e.clientX,
            lastY: e.clientY,
            lastT: performance.now(),
          };
          vel.current = { x: 0, y: 0 };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const now = performance.now();
          const dt = Math.max(8, now - d.lastT);
          vel.current = {
            x: ((e.clientX - d.lastX) / dt) * 16,
            y: ((e.clientY - d.lastY) / dt) * 16,
          };
          d.lastX = e.clientX;
          d.lastY = e.clientY;
          d.lastT = now;
          panNext.current = { x: d.vx + (e.clientX - d.px), y: d.vy + (e.clientY - d.py) };
          if (panRaf.current == null) panRaf.current = requestAnimationFrame(flushPan);
        }}
        onPointerUp={() => {
          drag.current = null;
          setPanning(false);
          const speed = Math.hypot(vel.current.x, vel.current.y);
          if (speed < 2.4) return;
          const tick = () => {
            vel.current.x *= 0.92;
            vel.current.y *= 0.92;
            if (Math.hypot(vel.current.x, vel.current.y) < 0.35) {
              inertia.current = null;
              return;
            }
            setView((v) => ({ ...v, x: v.x + vel.current.x, y: v.y + vel.current.y }));
            inertia.current = requestAnimationFrame(tick);
          };
          inertia.current = requestAnimationFrame(tick);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setPanning(false);
          stopInertia();
        }}
      >
        <div
          className="flow"
          style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0" }}
          role="presentation"
        >
          <svg className="wires" viewBox={`0 0 ${width} ${height}`} aria-hidden>
            <defs>
              <marker id="arr-on" markerWidth="7" markerHeight="7" refX="6.2" refY="3.5" orient="auto">
                <path d="M0,0.6 L6.4,3.5 L0,6.4" fill="none" stroke="var(--wire-on)" strokeWidth="1.35" />
              </marker>
              <marker id="arr-sel" markerWidth="7" markerHeight="7" refX="6.2" refY="3.5" orient="auto">
                <path d="M0,0.6 L6.4,3.5 L0,6.4" fill="none" stroke="var(--wire-sel)" strokeWidth="1.35" />
              </marker>
              <marker id="arr-bad" markerWidth="7" markerHeight="7" refX="6.2" refY="3.5" orient="auto">
                <path d="M0,0.6 L6.4,3.5 L0,6.4" fill="none" stroke="var(--danger)" strokeWidth="1.35" />
              </marker>
            </defs>
            {edges.map((e) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              const on = hot === e.from || hot === e.to;
              const bad = Boolean(fault) && (e.from === fault || e.to === fault);
              return (
                <Wire
                  key={`${e.from}-${e.to}`}
                  a={a}
                  b={b}
                  on={on}
                  dim={Boolean(hot) && !on && !bad}
                  bad={bad}
                  live={Boolean(live && on && !bad)}
                  ice={Boolean(live)}
                />
              );
            })}
          </svg>
          {nodes.map((n) => {
            const s = byId.get(n.id);
            if (!s) return null;
            return (
              <button
                key={s.id}
                type="button"
                className="node"
                data-kind={islands?.includes(s.id) ? "island" : s.kind}
                data-on={current === s.id ? "true" : "false"}
                data-drop={dropped?.includes(s.id) ? "true" : "false"}
                data-fault={fault === s.id ? "true" : "false"}
                aria-pressed={current === s.id}
                aria-label={`${kindLabel(s.kind)}: ${labelOf(s)}`}
                style={{ left: n.x, top: n.y, width: NW, minHeight: NH }}
                onPointerEnter={() => setHover(s.id)}
                onPointerLeave={() => setHover((h) => (h === s.id ? null : h))}
                onPointerDown={(e) => {
                  nodeGest.current = { id: s.id, x: e.clientX, y: e.clientY, panned: false };
                }}
                onPointerMove={(e) => {
                  const g = nodeGest.current;
                  if (!g || g.id !== s.id || g.panned) return;
                  if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 5) return;
                  g.panned = true;
                  stopInertia();
                  setPanning(true);
                  drag.current = {
                    px: g.x,
                    py: g.y,
                    vx: view.x,
                    vy: view.y,
                    lastX: e.clientX,
                    lastY: e.clientY,
                    lastT: performance.now(),
                  };
                  wrap.current?.setPointerCapture(e.pointerId);
                }}
                onClick={(e) => {
                  if (nodeGest.current?.panned) {
                    e.preventDefault();
                    nodeGest.current = null;
                    return;
                  }
                  nodeGest.current = null;
                  onSelect(s.id);
                  wrap.current?.focus({ preventScroll: true });
                }}
              >
                <i className="port in" aria-hidden hidden={!incoming.has(s.id)} />
                <i className="port out" aria-hidden hidden={!outgoing.has(s.id)} />
                <span className="k">{kindLabel(s.kind)}</span>
                <b>{labelOf(s)}</b>
                <p className="meta" title={detailOf(s)}>{detailOf(s)}</p>
              </button>
            );
          })}
          {!nodes.length ? <p className="empty">No steps in this stretch.</p> : null}
        </div>
      </div>
      <div className="canvas-hud">
        <button type="button" className="ghost" onClick={() => zoomAt(0.92)} title="Zoom out (⌘−)" aria-label="Zoom out">
          −
        </button>
        <button
          type="button"
          className="ghost hud-pct"
          onClick={actualSize}
          title="Actual size (⌘1)"
          aria-label={`Zoom ${Math.round(view.k * 100)} percent. Click for 100%.`}
        >
          {Math.round(view.k * 100)}%
        </button>
        <button type="button" className="ghost" onClick={() => zoomAt(1.09)} title="Zoom in (⌘+)" aria-label="Zoom in">
          +
        </button>
        <button type="button" className="ghost" onClick={fit} title="Fit to view (⌘0)" aria-keyshortcuts="Meta+0">
          Fit
        </button>
      </div>
      {nodes.length > 2 ? (
        <MiniMap live={Boolean(live)} nodes={nodes} width={width} height={height} view={view} wrapW={wrapSize.w} wrapH={wrapSize.h} onJump={jumpTo} />
      ) : null}
    </>
  );
}

function MiniMap({
  nodes,
  width,
  height,
  view,
  wrapW,
  wrapH,
  live,
  onJump,
}: {
  nodes: NodePos[];
  width: number;
  height: number;
  view: { x: number; y: number; k: number };
  wrapW: number;
  wrapH: number;
  live?: boolean;
  onJump: (wx: number, wy: number) => void;
}) {
  const s = Math.min(MINI_W / Math.max(width, 1), MINI_H / Math.max(height, 1));
  const ox = (MINI_W - width * s) / 2;
  const oy = (MINI_H - height * s) / 2;
  const vx = -view.x / view.k;
  const vy = -view.y / view.k;
  const vw = wrapW / view.k;
  const vh = wrapH / view.k;
  const vx1 = Math.max(0, Math.min(width, vx));
  const vy1 = Math.max(0, Math.min(height, vy));
  const vx2 = Math.max(0, Math.min(width, vx + vw));
  const vy2 = Math.max(0, Math.min(height, vy + vh));
  const drag = useRef(false);

  function jump(e: PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    onJump((e.clientX - rect.left - ox) / s, (e.clientY - rect.top - oy) / s);
  }

  return (
    <div
      className="minimap"
      aria-label="Canvas overview"
      tabIndex={0}
      onKeyDown={(e) => {
        const cx = (-view.x + wrapW / 2) / view.k;
        const cy = (-view.y + wrapH / 2) / view.k;
        const step = Math.max(width, height) * 0.12;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onJump(cx - step, cy);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onJump(cx + step, cy);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          onJump(cx, cy - step);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          onJump(cx, cy + step);
        }
      }}
      onPointerDown={(e) => {
        drag.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        jump(e);
      }}
      onPointerMove={(e) => {
        if (drag.current) jump(e);
      }}
      onPointerUp={() => {
        drag.current = false;
      }}
      onPointerCancel={() => {
        drag.current = false;
      }}
    >
      <svg viewBox={`0 0 ${MINI_W} ${MINI_H}`} width={MINI_W} height={MINI_H}>
        {nodes.map((n) => (
          <rect key={n.id} x={ox + n.x * s} y={oy + n.y * s} width={NW * s} height={NH * s} rx={1} fill="var(--faint)" />
        ))}
        <rect
          x={ox + vx1 * s}
          y={oy + vy1 * s}
          width={Math.max(8, (vx2 - vx1) * s)}
          height={Math.max(6, (vy2 - vy1) * s)}
          fill={live ? "color-mix(in oklch, var(--ok) 22%, transparent)" : "oklch(1 0 0 / 0.12)"}
          stroke={live ? "var(--ok)" : "var(--ink)"}
          strokeWidth={1}
        />
      </svg>
    </div>
  );
}

function Wire({
  a,
  b,
  on,
  dim,
  bad,
  live,
  ice,
}: {
  a: NodePos;
  b: NodePos;
  on: boolean;
  dim: boolean;
  bad: boolean;
  live: boolean;
  ice: boolean;
}) {
  const x1 = a.x + NW;
  const y1 = a.y + NH / 2;
  const x2 = b.x;
  const y2 = b.y + NH / 2;
  const dx = Math.max(36, Math.abs(x2 - x1) / 2);
  const d =
    x2 >= x1
      ? `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2} ${y2}`;
  const hot = on || bad;
  return (
    <path
      className={live ? "wire-live" : undefined}
      d={d}
      fill="none"
      stroke={bad ? "var(--danger)" : on ? (ice ? "var(--wire-on)" : "var(--wire-sel)") : "var(--wire)"}
      strokeWidth={hot ? 2.4 : 1.6}
      opacity={hot ? 1 : dim ? 0.22 : 0.85}
      markerEnd={bad ? "url(#arr-bad)" : on ? (ice ? "url(#arr-on)" : "url(#arr-sel)") : undefined}
    />
  );
}
