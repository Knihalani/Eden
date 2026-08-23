"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { homeEmptyLine, homePath, homeViewTitle, parseHomeView } from "../account/home";
import {
  formatCount,
  inboxItems,
  type DayPoint,
  type InboxItem,
} from "./activity";
import { useActivity } from "./activity-context";
import { HomeSkeleton } from "./skeletons";
import { SetupBlock } from "./prompt";
import { PLACEHOLDER_ENV } from "./prompt-text";

export function DashBoard() {
  const view = parseHomeView(useSearchParams().get("view"));
  const activity = useActivity();
  const items = useMemo(() => inboxItems(activity), [activity]);
  const requests = useMemo(() => items.filter((item) => item.kind === "request"), [items]);
  const workflows = useMemo(() => items.filter((item) => item.kind === "workflow"), [items]);
  const shown = view === "requests" ? requests : view === "workflows" ? workflows : items;
  const failed = Boolean(activity.failed);
  const overview = view === "overview";
  const connect =
    overview && activity.ready && !failed && requests.length === 0 && workflows.length === 0;
  const waiting = overview && !activity.ready && !failed;

  if (!overview) {
    return (
      <div className="home" data-view="list">
        <header className="home-head">
          <h1>{homeViewTitle(view)}</h1>
          <p className="home-head-n">{formatCount(shown.length)}</p>
        </header>
        <WorkSheet
          items={shown}
          vacant={shown.length === 0}
          empty={homeEmptyLine(view, failed)}
          label={homeViewTitle(view)}
        />
      </div>
    );
  }

  return (
    <div className="home" data-view="overview" data-empty={connect ? "true" : undefined}>
      <header className="home-head">
        <h1>Home</h1>
        {connect ? <p className="home-head-lede">Empty until you wrap</p> : null}
      </header>

      {waiting ? (
        <HomeSkeleton />
      ) : failed ? (
        <p className="home-empty-msg home-load-fail" role="status">
          {homeEmptyLine("overview", true)}
        </p>
      ) : connect ? (
        <ConnectBanner />
      ) : (
        <>
          <section className="home-metrics" aria-label="Activity">
            <Metric
              value={formatCount(failed ? 0 : activity.compiled)}
              label="Live tools"
              tone="ink"
              href={homePath("workflows")}
            />
            <Metric
              value={formatCount(failed ? 0 : activity.runs)}
              label="Compiled runs"
              tone="ink"
            />
            <Metric
              value={formatCount(failed ? 0 : activity.waiting)}
              label="Waiting"
              tone="ink"
              href={homePath("requests")}
            />
            <Metric
              value={formatCount(failed ? 0 : activity.fails)}
              label="Failed"
              tone={!failed && activity.fails > 0 ? "fail" : "ink"}
            />
          </section>

          <section className="home-chart">
            <h2>Compiled runs</h2>
            <p className="home-chart-range">Last 7 days</p>
            <RunChart series={activity.series} />
          </section>

          <section className="home-panel">
            <div className="home-panel-head">
              <h2>
                <Link href={homePath("requests")} prefetch={true}>
                  Needs attention
                </Link>
              </h2>
              <p data-hot={requests.length > 0 ? "true" : undefined}>{formatCount(requests.length)}</p>
            </div>
            <WorkSheet
              items={requests}
              vacant={requests.length === 0}
              empty={homeEmptyLine("requests", false)}
              label="Needs attention"
              compact
            />
          </section>

          <section className="home-panel">
            <div className="home-panel-head">
              <h2>
                <Link href={homePath("workflows")} prefetch={true}>
                  Live tools
                </Link>
              </h2>
              <p>{formatCount(workflows.length)}</p>
            </div>
            <WorkSheet
              items={workflows}
              vacant={workflows.length === 0}
              empty={homeEmptyLine("workflows", false)}
              label="Live tools"
              compact
            />
          </section>
        </>
      )}
    </div>
  );
}

function Metric({
  value,
  label,
  tone,
  href,
}: {
  value: string;
  label: string;
  tone: "ink" | "fail";
  href?: string;
}) {
  const body = (
    <>
      <b>{value}</b>
      <span>
        {label}
        {href ? (
          <span className="home-metric-go" aria-hidden="true">
            →
          </span>
        ) : null}
      </span>
    </>
  );
  if (!href) return <div className="home-metric" data-tone={tone}>{body}</div>;
  return (
    <Link className="home-metric" data-tone={tone} href={href} prefetch={true}>
      {body}
    </Link>
  );
}

function statusTone(status: string) {
  if (
    status.startsWith("Failed") ||
    status.startsWith("Refused") ||
    status.includes("Fail streak") ||
    status.startsWith("Loop") ||
    status.startsWith("Low gain") ||
    status.startsWith("Evidence")
  ) {
    return "fail";
  }
  if (status.startsWith("Ready")) return "ready";
  if (status === "Live") return "live";
  return "wait";
}

function WorkSheet({
  items,
  vacant,
  empty,
  label,
  compact = false,
}: {
  items: InboxItem[];
  vacant: boolean;
  empty: string;
  label: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "home-sheet home-sheet-compact" : "home-sheet"} data-vacant={vacant ? "true" : undefined}>
      {vacant ? null : (
        <div className="home-cols">
          <span>Name</span>
          <span>Status</span>
        </div>
      )}
      <div className="home-body">
        {vacant ? (
          <div className="home-empty" role="status">
            <p className="home-empty-msg">{empty}</p>
          </div>
        ) : (
          <WorkList items={items} label={label} />
        )}
      </div>
    </div>
  );
}

function WorkList({ items, label }: { items: InboxItem[]; label: string }) {
  return (
    <ul className="home-list" aria-label={label}>
      {items.map((item) => (
        <li key={item.id}>
          <Link href={item.href} className="home-row" prefetch={true}>
            <span className="home-row-name">{item.name}</span>
            <span className="home-row-status" data-tone={statusTone(item.status)}>
              <span className="home-pip" aria-hidden="true" />
              {item.status}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function RunChart({ series }: { series: DayPoint[] }) {
  const points = series.length ? series : [];
  const max = Math.max(1, ...points.map((point) => point.runs));
  const w = 700;
  const h = 156;
  const left = 8;
  const right = 8;
  const top = 10;
  const bottom = 26;
  const innerW = w - left - right;
  const innerH = h - top - bottom;
  const axis = top + innerH;
  const last = Math.max(points.length - 1, 1);
  const coords = points.map((point, i) => {
    const x = left + (i / last) * innerW;
    const y = axis - (point.runs / max) * innerH;
    return { x, y, label: point.label, runs: point.runs };
  });
  const line = coords.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${left},${axis} ${line} ${left + innerW},${axis}`;

  return (
    <svg
      className="home-plot"
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`Compiled runs, last 7 days: ${points.map((point) => `${point.label} ${point.runs}`).join(", ")}`}
    >
      <polygon className="home-plot-area" points={area} />
      <polyline className="home-plot-line" points={line} />
      <line className="home-plot-axis" x1={left} x2={w - right} y1={axis} y2={axis} />
      {coords.map((point) => (
        <text key={point.label} className="home-plot-tick" x={point.x} y={h - 6} textAnchor="middle">
          {point.label}
        </text>
      ))}
    </svg>
  );
}

function ConnectBanner() {
  return (
    <aside className="home-desk">
      <h2>Copy this into your agent</h2>
      <p>Paste the prompt into the agent you already run. After it wraps, requests and live tools show up here.</p>
      <SetupBlock placeholders={PLACEHOLDER_ENV} />
    </aside>
  );
}
