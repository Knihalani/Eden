"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { canaryLiveParts } from "@eden/ir";
import { homeEmptyLine, homePath, homeViewTitle, parseHomeView } from "../account/home";
import {
  formatCount,
  formatDcPct,
  inboxItems,
  statusTone,
  workflowServing,
  type DayPoint,
  type DcPoint,
  type FleetStrip,
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
  const serving = useMemo(() => workflowServing(activity.workflows), [activity.workflows]);
  const toolsTitle = homeViewTitle("workflows", serving);
  const toolsMetric =
    serving.canary && !failed ? canaryLiveParts(serving).join(" · ") : formatCount(failed ? 0 : activity.compiled);
  const overview = view === "overview";
  const connect = overview && activity.ready && !failed && requests.length === 0 && workflows.length === 0;
  const waiting = overview && !activity.ready && !failed;

  if (!overview) {
    return (
      <div className="home" data-view="list">
        <header className="home-head">
          <h1>{view === "workflows" ? toolsTitle : homeViewTitle(view)}</h1>
          <p className="home-head-n">{formatCount(shown.length)}</p>
        </header>
        <WorkSheet
          items={shown}
          vacant={shown.length === 0}
          empty={homeEmptyLine(view, failed)}
          label={view === "workflows" ? toolsTitle : homeViewTitle(view)}
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
            <Metric value={toolsMetric} label={toolsTitle} tone="ink" href={homePath("workflows")} />
            <Metric value={formatCount(failed ? 0 : activity.runs)} label="Compiled runs" tone="ink" />
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
            <Metric value={failed ? "—" : formatDcPct(activity.dcPct)} label="Deterministic share" tone="ink" />
          </section>

          <FleetStripView fleet={activity.fleet} />

          <section className="home-chart">
            <div className="home-chart-head">
              <h2>Compiled runs</h2>
              <p className="home-chart-range">
                Last 7 days
                {activity.dcSeries.some((point) => point.measured) ? " · DC%" : ""}
              </p>
            </div>
            <RunChart series={activity.series} dcSeries={activity.dcSeries} />
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
                  {toolsTitle}
                </Link>
              </h2>
              <p>{serving.canary ? canaryLiveParts(serving).join(" · ") : formatCount(workflows.length)}</p>
            </div>
            <WorkSheet
              items={workflows}
              vacant={workflows.length === 0}
              empty={homeEmptyLine("workflows", false)}
              label={toolsTitle}
              compact
            />
          </section>
        </>
      )}
    </div>
  );
}

function FleetStripView({ fleet }: { fleet?: FleetStrip }) {
  const agents = fleet?.agents ?? [];
  const dc = formatDcPct(fleet?.fleetDcPct ?? null);
  const shared = fleet?.sharedLine ?? null;
  const region = fleet?.region;
  return (
    <section className="home-fleet" aria-label="Fleet">
      <div className="home-fleet-metrics">
        <p>
          <b>{formatCount(agents.length)}</b>
          <span>Agents</span>
        </p>
        <p>
          <b>{dc}</b>
          <span>Fleet DC%</span>
        </p>
        <p>
          <b>{shared ?? "—"}</b>
          <span>Shared fetches</span>
        </p>
        {region ? (
          <p>
            <b>{region}</b>
            <span>Region</span>
          </p>
        ) : null}
      </div>
      {agents.length ? (
        <ul className="home-fleet-agents">
          {agents.map((agent) => (
            <li key={agent.id}>
              {agent.parentRunId ? `${agent.id} · child of ${agent.parentRunId}` : agent.id}
              {" · "}
              {formatDcPct(agent.dcPct)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Metric({ value, label, tone, href }: { value: string; label: string; tone: "ink" | "fail"; href?: string }) {
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
  if (!href)
    return (
      <div className="home-metric" data-tone={tone}>
        {body}
      </div>
    );
  return (
    <Link className="home-metric" data-tone={tone} href={href} prefetch={true}>
      {body}
    </Link>
  );
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

function RunChart({ series, dcSeries = [] }: { series: DayPoint[]; dcSeries?: DcPoint[] }) {
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
  const dcMeasured = dcSeries.some((point) => point.measured);
  const dcLast = Math.max(dcSeries.length - 1, 1);
  const dcCoords = dcSeries.map((point, i) => {
    const x = left + (i / dcLast) * innerW;
    const y = axis - (Math.max(0, Math.min(100, point.dcPct)) / 100) * innerH;
    return { x, y, label: point.label, dcPct: point.dcPct, measured: point.measured };
  });
  const dcLines: string[] = [];
  let cur: string[] = [];
  for (const point of dcCoords) {
    if (!point.measured) {
      if (cur.length > 1) dcLines.push(cur.join(" "));
      cur = [];
      continue;
    }
    cur.push(`${point.x},${point.y}`);
  }
  if (cur.length > 1) dcLines.push(cur.join(" "));
  const dcAria = dcMeasured
    ? ` DC%: ${dcSeries.map((point) => `${point.label} ${point.measured ? `${Math.round(point.dcPct)}%` : "not measured"}`).join(", ")}.`
    : "";

  return (
    <svg
      className="home-plot"
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`Compiled runs, last 7 days: ${points.map((point) => `${point.label} ${point.runs}`).join(", ")}.${dcAria}`}
    >
      <polygon className="home-plot-area" points={area} />
      <polyline className="home-plot-line" points={line} />
      {dcMeasured ? dcLines.map((pts) => <polyline key={pts} className="home-plot-line-dc" points={pts} />) : null}
      {dcMeasured
        ? dcCoords
            .filter((point) => point.measured)
            .map((point) => (
              <circle key={`dc-${point.label}`} className="home-plot-dc-dot" cx={point.x} cy={point.y} r="2.5" />
            ))
        : null}
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
      <p>{homeEmptyLine("overview")}</p>
      <SetupBlock placeholders={PLACEHOLDER_ENV} />
      <p>Empty is true. Metrics stay 0 until wrap records a run.</p>
    </aside>
  );
}
