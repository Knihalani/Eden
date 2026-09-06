"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useLayoutEffect, useState } from "react";
import { SETUP, homePath, homeViewTitle, navCurrent, parseHomeView } from "../account/home";
import { formatCount, workflowServing } from "./activity";
import { useActivity } from "./activity-context";

const NAV_KEY = "eden_nav";

export function useNavCollapsed() {
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    setCollapsed(window.localStorage.getItem(NAV_KEY) === "1");
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const onToggle = () => {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(NAV_KEY, next ? "1" : "0");
      return next;
    });
  };

  return { collapsed, ready, onToggle };
}

export function AppNav({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const path = usePathname();
  const view = parseHomeView(useSearchParams().get("view"));
  const { requests, workflows } = useActivity();
  const current = navCurrent(path, view);
  const requestN = requests?.length ?? 0;
  const workflowN = workflows?.length ?? 0;
  const toolsTitle = homeViewTitle("workflows", workflowServing(workflows ?? []));

  return (
    <nav className="app-nav" aria-label="Workspace">
      <div className="app-nav-main">
        <NavItem href={homePath("overview")} current={current === "overview"} mark="home" collapsed={collapsed}>
          Home
        </NavItem>
        <NavItem
          href={homePath("requests")}
          current={current === "requests"}
          count={requestN}
          mark="requests"
          collapsed={collapsed}
        >
          Requests
        </NavItem>
        <NavItem
          href={homePath("workflows")}
          current={current === "workflows"}
          count={workflowN}
          mark="workflows"
          collapsed={collapsed}
        >
          {toolsTitle}
        </NavItem>
      </div>
      <div className="app-nav-foot">
        <NavItem href={SETUP} current={current === "setup"} mark="setup" collapsed={collapsed}>
          Setup
        </NavItem>
        <button
          type="button"
          className="app-nav-fold"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggle}
        >
          <span className="app-nav-ico" aria-hidden="true">
            <FoldMark collapsed={collapsed} />
          </span>
          <span className="app-nav-label">{collapsed ? "Expand" : "Collapse"}</span>
        </button>
      </div>
    </nav>
  );
}

function NavItem({
  href,
  current,
  count,
  mark,
  collapsed,
  children,
}: {
  href: string;
  current: boolean;
  count?: number;
  mark: "home" | "requests" | "workflows" | "setup";
  collapsed: boolean;
  children: string;
}) {
  const hot = Boolean(count && count > 0);
  return (
    <Link
      href={href}
      prefetch={true}
      aria-current={current ? "page" : undefined}
      aria-label={count != null ? `${children}, ${formatCount(count)}` : children}
      title={collapsed ? children : undefined}
      data-hot={hot ? "true" : undefined}
    >
      <span className="app-nav-ico" aria-hidden="true">
        <NavMark name={mark} />
      </span>
      <span className="app-nav-label">{children}</span>
      {count != null ? (
        <span className="app-nav-n" data-hot={hot ? "true" : undefined}>
          {formatCount(count)}
        </span>
      ) : null}
    </Link>
  );
}

function NavMark({ name }: { name: "home" | "requests" | "workflows" | "setup" }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 18 18",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (name === "home") {
    return (
      <svg {...common}>
        <path d="M3 8.2 9 3.2 15 8.2" />
        <path d="M4.6 7.6V15h8.8V7.6" />
      </svg>
    );
  }
  if (name === "requests") {
    return (
      <svg {...common}>
        <path d="M4 5h10" />
        <path d="M4 9h10" />
        <path d="M4 13h6" />
      </svg>
    );
  }
  if (name === "workflows") {
    return (
      <svg {...common}>
        <circle cx="4.5" cy="9" r="1.6" />
        <circle cx="13.5" cy="5.2" r="1.6" />
        <circle cx="13.5" cy="12.8" r="1.6" />
        <path d="M6.2 9h5.2M11.8 6.4 6.4 8.4M11.8 11.6 6.4 9.6" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M7 3.5h4l.8 2.2H15v4.6h-3.2L11 14.5H7l-.8-4.2H3V5.7h3.2z" />
    </svg>
  );
}

function FoldMark({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden="true"
    >
      {collapsed ? (
        <>
          <path d="M7 4.5 12 9 7 13.5" />
        </>
      ) : (
        <>
          <path d="M11 4.5 6 9l5 4.5" />
        </>
      )}
    </svg>
  );
}
