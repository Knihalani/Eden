"use client";

/**
 * Minimal ⌘K / Ctrl+K command palette — filters buildNavCommands().
 * Signal Black instrument chrome (ds tokens); no purple / glow.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import {
  buildNavCommands,
  OPEN_AI_CHAT_HREF,
  type NavCommand,
} from "@/lib/nav-commands";
import { cn } from "@/lib/utils";

function matchesQuery(cmd: NavCommand, q: string): boolean {
  if (!q) return true;
  const hay = `${cmd.label} ${cmd.description ?? ""} ${cmd.group} ${cmd.href}`.toLowerCase();
  return q.split(/\s+/).every((token) => hay.includes(token));
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const titleId = useId();

  const commands = useMemo(() => buildNavCommands(), []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return commands.filter((c) => matchesQuery(c, q));
  }, [commands, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  const run = useCallback(
    (cmd: NavCommand) => {
      close();
      if (cmd.href === OPEN_AI_CHAT_HREF) {
        window.dispatchEvent(new CustomEvent(OPEN_AI_CHAT_HREF));
        router.push("/agent");
        return;
      }
      router.push(cmd.href);
    },
    [close, router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => {
          if (v) {
            setQuery("");
            setActive(0);
            return false;
          }
          return true;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(t);
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-cmd-index="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open, filtered.length]);

  if (!open) return null;

  const groups = (() => {
    const map = new Map<string, NavCommand[]>();
    for (const cmd of filtered) {
      const list = map.get(cmd.group) ?? [];
      list.push(cmd);
      map.set(cmd.group, list);
    }
    return [...map.entries()];
  })();

  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-[var(--scrim)] p-3 pt-[12vh] sm:p-6 sm:pt-[14vh]"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={close}
      data-eden-command-palette
    >
      <div
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-3">
          <Search
            className="h-4 w-4 shrink-0 text-[var(--text-faint)]"
            strokeWidth={1.6}
            aria-hidden
          />
          <input
            ref={inputRef}
            type="search"
            className="ds-input min-w-0 flex-1 border-0 bg-transparent px-0 py-3.5 shadow-none focus-visible:ring-0"
            placeholder="Go to…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) =>
                  filtered.length === 0 ? 0 : (i + 1) % filtered.length,
                );
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) =>
                  filtered.length === 0
                    ? 0
                    : (i - 1 + filtered.length) % filtered.length,
                );
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const cmd = filtered[active];
                if (cmd) run(cmd);
              }
            }}
            aria-autocomplete="list"
            aria-controls="command-palette-list"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="type-mono hidden shrink-0 rounded border border-[var(--line)] px-1.5 py-0.5 !text-[0.625rem] !text-[var(--text-faint)] sm:inline">
            esc
          </kbd>
        </div>

        <ul
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          className="max-h-[min(22rem,50vh)] overflow-y-auto py-2"
        >
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center">
              <p className="type-meta">No matches</p>
            </li>
          ) : (
            groups.map(([group, items]) => (
              <li key={group} className="px-2 pb-1">
                <p className="type-label px-2 py-1.5">{group}</p>
                <ul role="group" aria-label={group}>
                  {items.map((cmd) => {
                    flatIndex += 1;
                    const index = flatIndex;
                    const Icon = cmd.icon;
                    const selected = index === active;
                    return (
                      <li key={`${cmd.href}:${cmd.label}`} role="none">
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected}
                          data-cmd-index={index}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-2 text-left transition-colors",
                            selected
                              ? "bg-[var(--accent-muted)] text-[var(--text)]"
                              : "text-[var(--text)] hover:bg-[var(--bg-inset)]",
                          )}
                          onMouseEnter={() => setActive(index)}
                          onClick={() => run(cmd)}
                        >
                          <Icon
                            className={cn(
                              "h-3.5 w-3.5 shrink-0",
                              selected
                                ? "text-[var(--accent)]"
                                : "text-[var(--text-faint)]",
                            )}
                            strokeWidth={1.6}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1">
                            <span className="type-ui block truncate">
                              {cmd.label}
                            </span>
                            {cmd.description ? (
                              <span className="type-meta mt-0.5 block truncate">
                                {cmd.description}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
