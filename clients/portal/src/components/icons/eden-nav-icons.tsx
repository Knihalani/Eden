/**
 * Eden nav icons — thin semantic glyphs for sidebar collisions.
 *
 * Instrument-panel calm: 1.5px stroke, mono palette via currentColor
 * (callers tint with --accent / --node-* ). Used where Lucide reuse
 * made Insights≈Memory, Query≈Cost, Decisions≈Inspector.
 */

import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function NavGlyph({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Layered spans — Traces / observability spine. */
export function TraceIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M4 6h16" />
      <path d="M4 12h10" />
      <path d="M4 18h7" />
      <circle cx="18" cy="12" r="2" />
      <circle cx="15" cy="18" r="2" />
    </NavGlyph>
  );
}

/** Score bars — Eval. */
export function EvalIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M5 19V9" />
      <path d="M10 19V5" />
      <path d="M15 19v-7" />
      <path d="M20 19v-4" />
    </NavGlyph>
  );
}

/** Coin ring — Cost (never Sparkles). */
export function CostIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7v10" />
      <path d="M9.5 9.5c.6-1 1.7-1.5 2.5-1.5 1.4 0 2.5.9 2.5 2s-1.1 2-2.5 2h-1c-1.4 0-2.5.9-2.5 2s1.1 2 2.5 2c.9 0 1.9-.5 2.5-1.5" />
    </NavGlyph>
  );
}

/** Cluster burst — Incidents. */
export function IncidentIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M12 3 3.5 19h17L12 3Z" />
      <path d="M12 10v4" />
      <path d="M12 16.5h.01" />
    </NavGlyph>
  );
}

/** Hex bot — Agents. */
export function AgentIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M12 3 19 7.5v9L12 21l-7-4.5v-9L12 3Z" />
      <circle cx="9.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <path d="M9.5 15.5c.8.7 1.7 1 2.5 1s1.7-.3 2.5-1" />
    </NavGlyph>
  );
}

/** Diff patch — PR / code change. */
export function PatchIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M8 4v16" />
      <path d="M16 4v16" />
      <path d="M5 8h6" />
      <path d="M13 16h6" />
      <path d="M8 12h8" />
    </NavGlyph>
  );
}

/** Shield notch — Guardrails. */
export function GuardrailIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" />
      <path d="M9.5 12.5 11.5 14.5 15 10.5" />
    </NavGlyph>
  );
}

/** Bell pulse — Alerts. */
export function AlertNavIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M6.5 16.5h11" />
      <path d="M7 16.5V11a5 5 0 0 1 10 0v5.5" />
      <path d="M10 19a2 2 0 0 0 4 0" />
      <path d="M12 4v1.5" />
    </NavGlyph>
  );
}

/** Trend spark — Insights (≠ Memory Brain). */
export function InsightsIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M4 17 9 11l3.5 3.5L20 7" />
      <path d="M15 7h5v5" />
    </NavGlyph>
  );
}

/** Stack disks — Memory (single Brain-slot replacement stays unique). */
export function MemoryIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" />
      <path d="M5 6v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" />
      <path d="M5 10v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-4" />
      <path d="M5 14v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-4" />
    </NavGlyph>
  );
}

/** Prompt cursor — Query (≠ Cost Sparkles). */
export function QueryIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M5 6h14v10H9l-4 3V6Z" />
      <path d="M9 11h6" />
      <path d="M9 8h3" />
    </NavGlyph>
  );
}

/** Magnifier crosshair — Inspector (≠ Decisions Compass). */
export function InspectorIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M14.5 14.5 19 19" />
      <path d="M10.5 8v5" />
      <path d="M8 10.5h5" />
    </NavGlyph>
  );
}

/** Branch fork — Decisions. */
export function DecisionsIcon(props: IconProps) {
  return (
    <NavGlyph {...props}>
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="12" r="2" />
      <path d="M7 8v8" />
      <path d="M7 12h8" />
    </NavGlyph>
  );
}
