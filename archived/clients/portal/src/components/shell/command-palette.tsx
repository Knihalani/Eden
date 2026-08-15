"use client";

/**
 * ⌘K / Ctrl+K command palette.
 *
 * Wave 10 — no longer a static navigation index. On open (once per org
 * per session) it loads the org's live traces, issues, and agents and
 * surfaces them under "Runs" / "Issues" / "Agents" as you type, so ⌘K is a
 * true jump-to-anything: fuzzy-match a run by name/id/agent, an issue, an
 * agent, or paste a full trace id for a direct "Open run" jump.
 *
 * The static nav/actions/settings commands from buildNavCommands() remain,
 * merged beneath the live groups.
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
import {
  AlertTriangle,
  Bot,
  CornerDownLeft,
  GitBranch,
  Search,
  X,
} from "lucide-react";
import {
  buildNavCommands,
  OPEN_AI_CHAT_HREF,
  type NavCommand,
} from "@/lib/nav-commands";
import { useOrg } from "@/hooks/use-org";
import { portalApi } from "@/lib/api/portal";
import { OPEN_PALETTE_EVENT } from "@/lib/palette";
import { severityLabel } from "@/lab/lab-ui";
import type { AgentFixture } from "@/lab/fixtures/agents";
import type { IssueFixture } from "@/lab/fixtures/issues";
import type { TraceFixture } from "@/lab/fixtures/traces";
import { cn } from "@/lib/utils";

/**
 * One vocabulary for palette descriptions (Wave 11 mandate). Raw enums
 * ("error", "open", "live") must not leak into the result rows.
 */
function issueStatusLabel(status: string): string {
  if (status === "open") return "open";
  if (status === "acknowledged") return "in progress";
  if (status === "resolved") return "resolved";
  if (status === "ignored") return "dismissed";
  return status;
}

function agentStatusLabel(status: string): string {
  if (status === "live") return "active";
  if (status === "error") return "error";
  if (status === "idle") return "idle";
  return status;
}

function matchesQuery(cmd: NavCommand, q: string): boolean {
  if (!q) return true;
  const hay = `${cmd.label} ${cmd.description ?? ""} ${cmd.group} ${cmd.href}`.toLowerCase();
  return q.split(/\s+/).every((token) => hay.includes(token));
}

/** Field-scored live match: id-prefix beats id-contains beats name/agent. */
function liveScore(q: string, id: string, name: string, extra: string): number {
  const needle = q.trim().toLowerCase();
  if (!needle) return 0;
  const idL = id.toLowerCase();
  const nameL = name.toLowerCase();
  const extraL = extra.toLowerCase();
  if (idL.startsWith(needle)) return 0;
  if (idL.includes(needle)) return 1;
  if (nameL.includes(needle)) return 2;
  if (extraL.includes(needle)) return 3;
  return Number.MAX_SAFE_INTEGER;
}

type LiveData = {
  traces: TraceFixture[];
  issues: IssueFixture[];
  agents: AgentFixture[];
};

export function CommandPalette() {
  const router = useRouter();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const titleId = useId();
  const liveRef = useRef<{ org: string | null; data: LiveData | null }>({
    org: null,
    data: null,
  });
  const [liveLoaded, setLiveLoaded] = useState(false);
  const [, forceLive] = useState(0);

  // True while the live fetch for this org is still in flight (or hasn't
  // been attempted yet). Powers the "Loading runs…" skeleton row so an
  // empty palette doesn't read as "no data" before the fetch settles.
  const livePending =
    Boolean(open) && Boolean(orgId) && (liveRef.current.org !== orgId || !liveLoaded);

  const commands = useMemo(() => buildNavCommands(), []);

  // Load live data once per org per session (portal data is already
  // polling-fresh; one fetch per ⌘K session avoids an N+1 on every open).
  useEffect(() => {
    if (!open || !orgId) return;
    if (liveRef.current.org === orgId && liveRef.current.data) return;
    let cancelled = false;
    portalApi
      .agents(orgId)
      .then(async (agentList) => {
        const [traceList, issueList] = await Promise.all([
          portalApi.traces(orgId).catch(() => [] as TraceFixture[]),
          portalApi.issues(orgId).catch(() => [] as IssueFixture[]),
        ]);
        return { agents: agentList, traces: traceList, issues: issueList };
      })
      .then(({ agents: agentList, traces: traceList, issues: issueList }) => {
        if (cancelled) return;
        liveRef.current = {
          org: orgId,
          data: { traces: traceList, issues: issueList, agents: agentList },
        };
        setLiveLoaded(true);
        forceLive((n) => n + 1);
      })
      .catch(() => {
        // Offline / auth blip — palette keeps working with static commands.
        // Mark the fetch settled for THIS org (data stays null → the next
        // open retries) so the "Loading runs…" hint clears and static nav
        // stays front and center.
        if (!cancelled) {
          liveRef.current = { org: orgId, data: null };
          setLiveLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, orgId]);

  const live = liveRef.current.data;

  const liveTraces = useMemo(() => {
    if (!live || !orgId) return [];
    return live.traces
      .map((t) => ({ t, s: liveScore(query, t.id, t.name, t.agentId) }))
      .filter((x) => x.s !== Number.MAX_SAFE_INTEGER)
      .sort((a, b) => a.s - b.s)
      .slice(0, 6);
  }, [live, query, orgId]);

  const liveIssues = useMemo(() => {
    if (!live || !orgId) return [];
    return live.issues
      .map((i) => ({ i, s: liveScore(query, i.id, i.title, i.agentId) }))
      .filter((x) => x.s !== Number.MAX_SAFE_INTEGER)
      .sort((a, b) => a.s - b.s)
      .slice(0, 4);
  }, [live, query, orgId]);

  const liveAgents = useMemo(() => {
    if (!live || !orgId) return [];
    return live.agents
      .map((a) => ({ a, s: liveScore(query, a.id, a.name, a.purpose) }))
      .filter((x) => x.s !== Number.MAX_SAFE_INTEGER)
      .sort((a, b) => a.s - b.s)
      .slice(0, 4);
  }, [live, query, orgId]);

  const staticFiltered = useMemo(
    () => commands.filter((c) => matchesQuery(c, query)),
    [commands, query],
  );

  // Direct jump: a plausible trace id that no live trace matched exactly.
  const q = query.trim();
  const directJump: NavCommand | null = useMemo(() => {
    if (!q || q.length < 8) return null;
    if (!/^[a-zA-Z0-9_.-]+$/.test(q)) return null;
    const exact = liveTraces.some(({ t }) => t.id === q);
    if (exact) return null;
    return {
      href: `/traces?id=${encodeURIComponent(q)}`,
      label: `Open run ${q.length > 40 ? `${q.slice(0, 40)}…` : q}`,
      description: "Jump straight to this trace id",
      group: "Runs",
      icon: CornerDownLeft,
      kind: "action",
    };
  }, [q, liveTraces]);

  const filtered = useMemo(() => {
    const live: NavCommand[] = [];
    if (liveTraces.length) {
      live.push(
        ...liveTraces.map<NavCommand>(({ t }) => ({
          href: `/traces?id=${encodeURIComponent(t.id)}&agent=${encodeURIComponent(t.agentId)}`,
          label: t.name,
          description: `run · ${t.id.slice(0, 18)} · ${t.agentId} · ${severityLabel(t.severity)}`,
          group: "Runs",
          icon: GitBranch,
          kind: "route",
        })),
      );
    }
    if (directJump) live.push(directJump);
    if (liveIssues.length) {
      live.push(
        ...liveIssues.map<NavCommand>(({ i }) => ({
          href: `/issues?id=${encodeURIComponent(i.id)}&agent=${encodeURIComponent(i.agentId)}`,
          label: i.title,
          description: `issue · ${issueStatusLabel(i.status)} · ${severityLabel(i.severity)}`,
          group: "Issues",
          icon: AlertTriangle,
          kind: "route",
        })),
      );
    }
    if (liveAgents.length) {
      live.push(
        ...liveAgents.map<NavCommand>(({ a }) => ({
          href: `/agents?id=${encodeURIComponent(a.id)}`,
          label: a.name,
          description: `agent · ${agentStatusLabel(a.status)} · ${a.purpose}`,
          group: "Agents",
          icon: Bot,
          kind: "route",
        })),
      );
    }
    // Idle palette: Home / static nav first so default highlight is Home.
    // Typing: live matches rank above static.
    if (!query.trim()) return [...staticFiltered, ...live];
    return [...live, ...staticFiltered];
  }, [liveTraces, liveIssues, liveAgents, directJump, staticFiltered, query]);

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
    // Visible triggers (sidebar / mobile header) open via this event too.
    const onOpenEvent = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenEvent);
    };
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
            className="ds-input min-w-0 flex-1 border-0 bg-transparent px-0 py-3.5 shadow-none focus-visible:ring-0 [&::-webkit-search-cancel-button]:hidden"
            placeholder="Go to a run, issue, agent, or page…"
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
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="ds-btn ds-btn-ghost ds-btn-icon shrink-0 !h-6 !w-6"
              aria-label="Clear search"
              title="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <kbd className="type-mono hidden shrink-0 rounded border border-[var(--line)] px-1.5 py-0.5 !text-[0.625rem] !text-[var(--text-faint)] sm:inline">
            esc
          </kbd>
        </div>

        {/* Live-data hint sits OUTSIDE the listbox (a `role=status` row
            inside `role=listbox` would violate ARIA nesting) and never
            replaces the static commands — jump-to-page works even while
            the live fetch is in flight or failed. */}
        {livePending && query.trim() && staticFiltered.length === 0 ? (
          <p role="status" className="border-b border-[var(--line)] px-4 py-2 type-meta">
            Loading runs…
          </p>
        ) : null}

        <ul
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          className="max-h-[min(26rem,55vh)] overflow-y-auto py-2"
        >
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center">
              <p className="type-ui text-[var(--text)]">
                No matches{query ? ` for “${query}”` : ""}
              </p>
              <p className="type-meta mt-1">
                Try a run id, issue title, agent name, or page.
              </p>
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

        {/* Keyboard hints — the palette is a keyboard-first surface; the
            footer makes the shortcuts visible to mouse users too. */}
        <div className="flex items-center gap-3 border-t border-[var(--line)] px-3 py-2">
          <span className="type-mono !text-[0.625rem] text-[var(--text-faint)]">
            ↑↓ navigate
          </span>
          <span className="type-mono !text-[0.625rem] text-[var(--text-faint)]">
            ↵ open
          </span>
          <span className="type-mono !text-[0.625rem] text-[var(--text-faint)]">
            esc close
          </span>
        </div>
      </div>
    </div>
  );
}
