"use client";

import {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import { Command as Cmnd } from "cmdk";
import { useRouter, usePathname } from "next/navigation";
import { Search, X, ChevronRight } from "lucide-react";
import { cn, isExternalHref } from "@/lib/utils";
import {
  COMMAND_PALETTE_RECENT_KEY,
  COMMAND_PALETTE_RECENT_LIMIT,
} from "@/lib/constants";
import { buildNavCommands, type NavCommand } from "@/lib/nav-commands";

/** Focusable controls inside the palette dialog (Tab trap). */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Track focus while closed so Esc/close restores the pre-open trigger.
  // Capturing on open (useEffect after paint) stores the cmdk input —
  // which unmounts on close — so focus would drop to <body> (F4).
  useEffect(() => {
    if (open) return;
    const track = () => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || el === document.body) return;
      if (el.closest('[aria-label="Command palette"]')) return;
      lastFocusRef.current = el;
    };
    track();
    document.addEventListener("focusin", track);
    return () => document.removeEventListener("focusin", track);
  }, [open]);

  // On open: move focus into the search field. On close: restore prior focus.
  useLayoutEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      setRecentHrefs(readRecent());
      const input =
        inputRef.current ??
        dialogRef.current?.querySelector<HTMLInputElement>("[cmdk-input]");
      input?.focus();
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    const el = lastFocusRef.current;
    if (!el || typeof el.focus !== "function") return;
    const t = window.setTimeout(() => {
      try {
        if (el.isConnected) el.focus();
      } catch {
        /* node unmounted */
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, [open]);

  // Esc close + Tab focus trap. Cmd/Ctrl+K stays owned by portal chrome
  // (dedup — do not register K here).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables =
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

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
      if (path === "eden:open-ai-chat") {
        window.dispatchEvent(new CustomEvent("eden:ask-ai"));
        return;
      }
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
    <div className="fixed inset-0 z-50" role="presentation">
      <div
        className="fixed inset-0 bg-[var(--bg-base)]/40 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <Cmnd
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
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
            ref={inputRef}
            value={search}
            onValueChange={setSearch}
            placeholder="Search pages, observability, settings…"
            className="flex-1 py-4 text-sm outline-none bg-transparent placeholder:text-[var(--text-muted)]"
          />
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close command palette"
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] p-1 hover:bg-[var(--bg-tertiary)] rounded transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
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
