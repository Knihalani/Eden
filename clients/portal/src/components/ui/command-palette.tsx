"use client";

import { useState, useEffect } from "react";
import { Command as Cmnd } from "cmdk";
import { useRouter } from "next/navigation";
import {
  Search,
  Plus,
  FileCode,
  Settings,
  Bell,
  ChevronRight,
  ArrowRight,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange]);

  const runCommand = (path: string) => {
    onOpenChange(false);
    router.push(path);
  };

  return (
    <div className="fixed inset-0 z-50">
      {open && (
        <div
          className="fixed inset-0 bg-[var(--bg-base)]/40 backdrop-blur-sm"
          onClick={() => onOpenChange(false)}
        />
      )}
      <Cmnd
        className={cn(
          "fixed left-1/2 top-[20%] -translate-x-1/2 w-full max-w-lg",
          "bg-[var(--bg-primary)] rounded-2xl shadow-2xl border border-[var(--border-default)] overflow-hidden",
          "flex flex-col",
          open ? "animate-scale-in" : "hidden"
        )}
        style={{ maxHeight: "60vh" }}
      >
        <div className="flex items-center gap-3 px-4 border-b border-[var(--border-subtle)]">
          <Search className="w-5 h-5 text-[var(--text-muted)] flex-shrink-0" />
          <Cmnd.Input
            value={search}
            onValueChange={setSearch}
            placeholder="Search commands, jobs, files..."
            className="flex-1 py-4 text-sm outline-none bg-transparent placeholder:text-[var(--text-muted)]"
          />
          <button
            onClick={() => onOpenChange(false)}
            className="p-1 hover:bg-[var(--bg-tertiary)] rounded transition-colors"
          >
            <X className="w-4 h-4 text-[var(--text-muted)]" />
          </button>
        </div>

        <Cmnd.List className="flex-1 overflow-y-auto p-2">
          <Cmnd.Empty className="py-6 text-center text-sm text-[var(--text-muted)]">
            No results found.
          </Cmnd.Empty>

          <Cmnd.Group heading="Navigation" className="px-2">
            <Cmnd.Item
              onSelect={() => runCommand("/jobs/new")}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-[var(--accent-faint)] flex items-center justify-center">
                <Plus className="w-4 h-4 text-[var(--accent)]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">New Job</p>
                <p className="text-xs text-[var(--text-muted)]">Create a new environment generation job</p>
              </div>
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
            </Cmnd.Item>

            <Cmnd.Item
              onSelect={() => runCommand("/jobs")}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-[var(--bg-tertiary)] flex items-center justify-center">
                <FileCode className="w-4 h-4 text-[var(--text-secondary)]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">Jobs</p>
                <p className="text-xs text-[var(--text-muted)]">View all your jobs</p>
              </div>
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
            </Cmnd.Item>

            <Cmnd.Item
              onSelect={() => runCommand("/dashboard")}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-[var(--terminal-faint)] flex items-center justify-center">
                <svg className="w-4 h-4 text-[var(--terminal)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">Dashboard</p>
                <p className="text-xs text-[var(--text-muted)]">View analytics and statistics</p>
              </div>
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
            </Cmnd.Item>

            <Cmnd.Item
              onSelect={() => runCommand("/docs")}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-[var(--accent-faint)] flex items-center justify-center">
                <svg className="w-4 h-4 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">Documentation</p>
                <p className="text-xs text-[var(--text-muted)]">API docs and guides</p>
              </div>
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
            </Cmnd.Item>

            <Cmnd.Item
              onSelect={() => runCommand("/settings")}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-[var(--bg-tertiary)] flex items-center justify-center">
                <Settings className="w-4 h-4 text-[var(--text-secondary)]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">Settings</p>
                <p className="text-xs text-[var(--text-muted)]">Manage your account and organization</p>
              </div>
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
            </Cmnd.Item>
          </Cmnd.Group>

          <Cmnd.Group heading="Actions" className="px-2 mt-2">
            <Cmnd.Item
              onSelect={() => {
                onOpenChange(false);
                if (typeof window !== "undefined") {
                  window.location.href = "/jobs/new";
                }
              }}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-[var(--terminal-faint)] flex items-center justify-center">
                <ArrowRight className="w-4 h-4 text-[var(--terminal)]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">Create Job</p>
                <p className="text-xs text-[var(--text-muted)]">Start a new environment generation</p>
              </div>
            </Cmnd.Item>
          </Cmnd.Group>

          <div className="px-4 py-3 border-t border-[var(--border-subtle)] mt-2">
            <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-muted)] font-mono">↑↓</kbd>
                Navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-muted)] font-mono">↵</kbd>
                Select
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-muted)] font-mono">Esc</kbd>
                Close
              </span>
            </div>
          </div>
        </Cmnd.List>
      </Cmnd>
    </div>
  );
}