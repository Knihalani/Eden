"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  BookOpen,
  ChevronDown,
  GitBranch,
  Key,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { TimeRangeControl } from "./time-range-control";

/**
 * Home header actions — ≤5 toolbar controls; one primary CTA (Wave 6 / 7).
 * Layout editor removed — Home order is fixed (Status → Diagnosis → Action).
 */
export function HomeHeaderActions({
  isFirstRun,
  canManageKeys,
  canConnect,
  windowHours,
  onWindowHoursChange,
}: {
  isFirstRun: boolean;
  canManageKeys: boolean;
  canConnect: boolean;
  windowHours: number;
  onWindowHoursChange: (hours: number) => void;
}) {
  if (isFirstRun) {
    return (
      <div
        className="flex flex-wrap items-center gap-space-2"
        data-home-shell-toolbar="first-run"
      >
        {canManageKeys ? (
          <Button asChild className="min-h-11">
            <Link href="/settings?tab=api-keys">
              <Key className="w-3.5 h-3.5" />
              API keys
            </Link>
          </Button>
        ) : (
          <Button asChild className="min-h-11">
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <BookOpen className="w-3.5 h-3.5" />
              Docs
            </a>
          </Button>
        )}
        {canManageKeys ? (
          <Button asChild variant="ghost" className="min-h-11">
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <BookOpen className="w-3.5 h-3.5" />
              Docs
            </a>
          </Button>
        ) : (
          <span className="text-xs text-[var(--text-muted)] px-space-3 py-space-2">
            Ask an admin for an API key
          </span>
        )}
        {canConnect ? (
          <Button asChild variant="ghost" className="min-h-11">
            <Link href="/agents/connect">
              <GitBranch className="w-3.5 h-3.5" />
              Connect
            </Link>
          </Button>
        ) : null}
      </div>
    );
  }

  // ≤5: time range · Open Traces (ghost — diagnosis owns the accent) · More
  return (
    <div
      className="flex flex-wrap items-center gap-space-2"
      data-home-shell-toolbar="≤5"
    >
      <TimeRangeControl
        windowHours={windowHours}
        onChange={onWindowHoursChange}
      />
      <Button asChild variant="ghost" className="min-h-11">
        <Link href="/traces">
          <Activity className="w-3.5 h-3.5" />
          Open Traces
        </Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11"
            aria-label="More home actions"
          >
            More
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[12rem]">
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <Link href="/issues">
              <AlertTriangle className="h-3.5 w-3.5" />
              Issues
            </Link>
          </DropdownMenuItem>
          {canConnect ? (
            <DropdownMenuItem asChild>
              <Link href="/agents/connect">
                <GitBranch className="h-3.5 w-3.5" />
                Connect
              </Link>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
