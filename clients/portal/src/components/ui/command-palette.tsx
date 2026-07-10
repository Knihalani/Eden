"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Command as Cmnd } from "cmdk";
import { useRouter, usePathname } from "next/navigation";
import { Search, X, ChevronRight } from "lucide-react";
import { cn, isExternalHref } from "@/lib/utils";
import {
  COMMAND_PALETTE_RECENT_KEY,
  COMMAND_PALETTE_RECENT_LIMIT,
} from "@/lib/constants";
import { buildNavCommands, type NavCommand } from "@/lib/nav-commands";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type NavEntry = NavCommand & {
  accent?: "accent" | "terminal" | "muted";
};

const COMMANDS: NavEntry[] = buildNavCommands().map((cmd) => ({
  ...cmd,
  ...(cmd.href === "/dashboard"
    ? { accent: "terminal" as const }
    : cmd.href === "/builder"
      ? { accent: "accent" as const }
      : cmd.href === "/optimization"
        ? { accent: "accent" as const }
        : {}),
}));

const ACCENT_BG: Record<NonNullable<NavEntry["accent"]>, string> = {
  accent: "bg-[var(--accent-faint)] text-[var(--accent)]",
  terminal: "bg-[var(--terminal-faint)] text-[var(--terminal)]",
  muted: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]" };

const COMMANDS_BY_HREF = new Map(COMMANDS.map((c) => [c.href, c]));

function readRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(COMMAND_PALETTE_RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeRecent(items: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COMMAND_PALETTE_RECENT_KEY, JSON.stringify(items));
  } catch {
    // quota / disabled — fail silently, recent is a nice-to-have
  }
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [search, setSearch] = useState("");
  const [recentHrefs, setRecentHrefs] = useState<string[]>([]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Cmd/Ctrl+K toggling is owned by the (portal) layout
      // (so it lives next to the other global shortcuts like
      // Cmd/Ctrl+B and \). Re-implementing it here would
      // double-fire on every keystroke — the layout's
      // setCommandPaletteOpen((prev) => !prev) and the palette's
      // stale-closure onOpenChange(!open) both reach for the
      // same toggle and race. The palette only owns its own
      // Escape-close path because that's intrinsic to the
      // popover — pressing Esc inside the input needs to bubble
      // here even when the layout isn't paying attention.
      if (e.key === "Escape" && open) {
        e.preventDefault();
        onOpenChange(false);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange]);

  // Re-read recent items each time the palette opens.
  // F4: also capture the previously-focused element so we can restore
  // focus to it after the palette closes (it isn't a Radix Dialog, so
  // Radix's auto-restore doesn't apply).
  const lastFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      lastFocusRef.current = (document.activeElement as HTMLElement) ?? null;
      setRecentHrefs(readRecent());
    } else if (lastFocusRef.current && typeof lastFocusRef.current.focus === "function") {
      // Defer to the next tick so we don't fight with anything else
      // closing at the same time (e.g. the ⌘K handler that toggled
      // us off also tries to refocus its trigger).
      const t = window.setTimeout(() => {
        try { lastFocusRef.current?.focus(); } catch { /* node unmounted */ }
      }, 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  // Track the current route as recently visited (only for routes the
  // command palette knows about — random 404s shouldn't pollute the list).
  useEffect(() => {
    if (!pathname) return;
    const known = COMMANDS_BY_HREF.get(pathname);
    if (!known) return;
    const recent = readRecent().filter((h) => h !== pathname);
    recent.unshift(pathname);
    const trimmed = recent.slice(0, COMMAND_PALETTE_RECENT_LIMIT);
    writeRecent(trimmed);
    setRecentHrefs(trimmed);
    // pathname is the only signal we care about; the localStorage reads
    // are idempotent.
     
  }, [pathname]);

  const runCommand = useCallback(
    (path: string) => {
      onOpenChange(false);
      if (isExternalHref(path)) {
        window.open(path, "_blank", "noopener,noreferrer");
        return;
      }
      router.push(path);
    },
    [onOpenChange, router],
  );

  // Group commands by their `group` field, preserving the order
  // they were declared in (which mirrors the sidebar).
  const grouped = useMemo(
    () =>
      COMMANDS.reduce<Record<string, NavEntry[]>>((acc, c) => {
        (acc[c.group] = acc[c.group] || []).push(c);
        return acc;
      }, {}),
    [],
  );

  const recentEntries = useMemo(
    () =>
      recentHrefs
        .map((href) => COMMANDS_BY_HREF.get(href))
        .filter((entry): entry is NavEntry => Boolean(entry)),
    [recentHrefs],
  );

  const hasResults = search.trim().length > 0;
  const showFooter = !hasResults;
  const showRecent = recentEntries.length > 0 && !hasResults;

  // Conditionally render the entire tree. The previous version
  // always mounted a ``fixed inset-0 z-50`` wrapper even when
  // ``open === false``; combined with the mobile sidebar overlay
  // and the chat toggle (also ``z-40``/``z-50``), this added an
  // empty full-viewport layer on every page that mounted
  // <CommandPalette />. Returning ``null`` when closed keeps the
  // DOM minimal and removes any chance of an invisible z-50
  // overlay intercepting clicks on the page below.
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div
        className="fixed inset-0 bg-[var(--bg-base)]/40 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <Cmnd
        className={cn(
          // FIX-G: center vertically. The previous `top-[20%]`
          // anchored the menu 20% from the top of the viewport,
          // which on a 1080p screen put it visibly above center.
          // `top-1/2 -translate-y-1/2` puts it dead-center.
          "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-[calc(100vw-2rem)] sm:max-w-lg",
          "bg-[var(--bg-primary)] rounded-2xl shadow-2xl border border-[var(--border-default)] overflow-hidden",
          "flex flex-col",
          "animate-scale-in"
        )}
        // Smaller on phones (60vh leaves the keyboard covering most
        // results), taller on desktop. June 2026 layout-pass fix.
        style={{ maxHeight: "min(60vh, 480px)" }}
      >
        <div className="flex items-center gap-3 px-4 border-b border-[var(--border-subtle)]">
          <Search className="w-5 h-5 text-[var(--text-muted)] flex-shrink-0" />
          <Cmnd.Input
            value={search}
            onValueChange={setSearch}
            placeholder="Search pages, observability, settings…"
            className="flex-1 py-4 text-sm outline-none bg-transparent placeholder:text-[var(--text-muted)]"
          />
          <button
            onClick={() => onOpenChange(false)}
            aria-label="Close command palette"
            className="p-1 hover:bg-[var(--bg-tertiary)] rounded transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          >
            <X className="w-4 h-4 text-[var(--text-muted)]" />
          </button>
        </div>

        <Cmnd.List className="flex-1 overflow-y-auto p-2">
          <Cmnd.Empty className="py-6 text-center text-sm text-[var(--text-muted)]">
            No results found.
          </Cmnd.Empty>

          {showRecent && (
            <Cmnd.Group heading="Recent" className="px-2 mt-2 first:mt-0">
              {recentEntries.map((item) => {
                const Icon = item.icon;
                const accentClass = item.accent
                  ? ACCENT_BG[item.accent]
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]";
                return (
                  <Cmnd.Item
                    key={`recent-${item.href}`}
                    value={`${item.label} ${item.href} Recent`}
                    onSelect={() => runCommand(item.href)}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
                  >
                    <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", accentClass)}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--text-primary)]">{item.label}</p>
                      {item.description && (
                        <p className="text-xs text-[var(--text-muted)]">{item.description}</p>
                      )}
                    </div>
                    <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
                  </Cmnd.Item>
                );
              })}
            </Cmnd.Group>
          )}

          {Object.entries(grouped).map(([group, items]) => (
            <Cmnd.Group key={group} heading={group} className="px-2 mt-2 first:mt-0">
              {items.map((item) => {
                const Icon = item.icon;
                const accentClass = item.accent
                  ? ACCENT_BG[item.accent]
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]";
                return (
                  <Cmnd.Item
                    key={item.href}
                    value={`${item.label} ${item.href} ${group}`}
                    onSelect={() => runCommand(item.href)}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
                  >
                    <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", accentClass)}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--text-primary)]">{item.label}</p>
                      {item.description && (
                        <p className="text-xs text-[var(--text-muted)]">{item.description}</p>
                      )}
                    </div>
                    <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
                  </Cmnd.Item>
                );
              })}
            </Cmnd.Group>
          ))}

          {showFooter && (
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
          )}
        </Cmnd.List>
      </Cmnd>
    </div>
  );
}
