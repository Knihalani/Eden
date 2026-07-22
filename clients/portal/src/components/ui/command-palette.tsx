"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useClerk } from "@clerk/nextjs";
import { Command } from "cmdk";
import { useTranslations } from "next-intl";
import { LogOut, MessagesSquare, Search, MessageSquare, Bug, FileText, BarChart3 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { getCoreNavLeaves } from "@/lib/sidebar-config";
import { cn } from "@/lib/utils";

/** Custom event — PortalHeader Search dispatches this to open the palette. */
export const COMMAND_PALETTE_OPEN_EVENT = "eden:open-command-palette";

/** Sessions is a Traces lens, not a 13th IA leaf. */
const SESSIONS_PALETTE_HREF = "/traces?view=sessions";

export function openCommandPalette(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
  }
}

/**
 * Single CommandPalette implementation (kill-list: one module max).
 * ⌘K / Ctrl+K · 12 IA leaves + Sessions lens + Open AI + Debugger + sign-out.
 */
export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  const { signOut } = useClerk();
  const tLeaves = useTranslations("nav.leaves");
  const t = useTranslations("commandPalette");
  const leaves = React.useMemo(() => getCoreNavLeaves(), []);

  // Lazy import to avoid circular dep — AiSessionProvider must be in tree
  const openAiRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    openAiRef.current = () => {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("eden:ask-ai", { detail: {} }));
      }
    };
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    };
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="overflow-hidden p-0 gap-0 max-w-lg"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{t("placeholder")}</DialogTitle>
        <Command
          className="flex flex-col"
          label={t("placeholder")}
          shouldFilter
        >
          <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3">
            <Search
              className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
              aria-hidden
            />
            <Command.Input
              placeholder={t("placeholder")}
              className={cn(
                "h-11 w-full bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none",
                FOCUS_RING_CLASS,
              )}
            />
          </div>
          <Command.List className="max-h-[min(60vh,360px)] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">
              {t("empty")}
            </Command.Empty>
            <Command.Group
              heading={t("navigation")}
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[var(--text-muted)]"
            >
              {leaves.map((item) => {
                const leafKey = item.id as Parameters<typeof tLeaves>[0];
                return (
                  <Command.Item
                    key={item.id}
                    value={`${item.id} ${tLeaves(leafKey)}`}
                    onSelect={() => go(item.href)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--text-secondary)]",
                      "data-[selected=true]:bg-[var(--accent-faint)] data-[selected=true]:text-[var(--accent)]",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0 opacity-80" />
                    <span>{tLeaves(leafKey)}</span>
                  </Command.Item>
                );
              })}
              <Command.Item
                value={`sessions ${t("sessions")}`}
                onSelect={() => go(SESSIONS_PALETTE_HREF)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--text-secondary)]",
                  "data-[selected=true]:bg-[var(--accent-faint)] data-[selected=true]:text-[var(--accent)]",
                )}
              >
                <MessagesSquare className="h-4 w-4 shrink-0 opacity-80" />
                <span>{t("sessions")}</span>
              </Command.Item>
              <Command.Item
                value={`open-ai ${t("openAi")}`}
                onSelect={() => {
                  setOpen(false);
                  openAiRef.current?.();
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--text-secondary)]",
                  "data-[selected=true]:bg-[var(--accent-faint)] data-[selected=true]:text-[var(--accent)]",
                )}
              >
                <MessageSquare className="h-4 w-4 shrink-0 opacity-80" />
                <span>{t("openAi")}</span>
              </Command.Item>
              <Command.Item
                value={`debugger ${t("debugger")}`}
                onSelect={() => go("/debugger")}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--text-secondary)]",
                  "data-[selected=true]:bg-[var(--accent-faint)] data-[selected=true]:text-[var(--accent)]",
                )}
              >
                <Bug className="h-4 w-4 shrink-0 opacity-80" />
                <span>{t("debugger")}</span>
              </Command.Item>
              <Command.Item
                value={`prompts ${t("prompts")}`}
                onSelect={() => go("/prompts")}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--text-secondary)]",
                  "data-[selected=true]:bg-[var(--accent-faint)] data-[selected=true]:text-[var(--accent)]",
                )}
              >
                <FileText className="h-4 w-4 shrink-0 opacity-80" />
                <span>{t("prompts")}</span>
              </Command.Item>
              <Command.Item
                value={`analytics ${t("analytics")}`}
                onSelect={() => go("/analytics")}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--text-secondary)]",
                  "data-[selected=true]:bg-[var(--accent-faint)] data-[selected=true]:text-[var(--accent)]",
                )}
              >
                <BarChart3 className="h-4 w-4 shrink-0 opacity-80" />
                <span>{t("analytics")}</span>
              </Command.Item>
            </Command.Group>
            <Command.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
            <Command.Item
              value={`sign-out ${t("signOut")}`}
              onSelect={async () => {
                setOpen(false);
                await signOut({ redirectUrl: "/sign-in" });
              }}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--text-secondary)]",
                "data-[selected=true]:bg-[var(--accent-faint)] data-[selected=true]:text-[var(--accent)]",
              )}
            >
              <LogOut className="h-4 w-4 shrink-0 opacity-80" />
              <span>{t("signOut")}</span>
            </Command.Item>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
