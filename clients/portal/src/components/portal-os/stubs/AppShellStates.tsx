/**
 * U18 Storybook fixtures — shell states for visual regression.
 * Import into Storybook when the portal design system catalog ships.
 */
import type { ReactNode } from "react";
import { AppShell } from "../AppShell";
import { ResourcePageShell } from "../ResourcePageShell";
import { MobileBottomNav } from "../MobileBottomNav";

function ShellFrame({
  state,
  children,
}: {
  state: "loading" | "empty" | "error" | "collapsed" | "mobile";
  children: ReactNode;
}) {
  return (
    <div data-fixture={state} className="min-h-[24rem] border border-[var(--border-default)] rounded-lg overflow-hidden">
      {children}
    </div>
  );
}

export function AppShellLoadingFixture() {
  return (
    <ShellFrame state="loading">
      <AppShell density="comfortable" hideChrome>
        <div className="flex flex-1 items-center justify-center p-12 text-sm text-[var(--text-muted)]">
          Loading portal…
        </div>
      </AppShell>
    </ShellFrame>
  );
}

export function AppShellEmptyFixture() {
  return (
    <ShellFrame state="empty">
      <ResourcePageShell
        header={<p className="text-sm font-medium">Traces</p>}
        table={
          <div className="py-16 text-center text-sm text-[var(--text-muted)]">
            No traces in this window.
          </div>
        }
      />
    </ShellFrame>
  );
}

export function AppShellErrorFixture() {
  return (
    <ShellFrame state="error">
      <ResourcePageShell
        header={<p className="text-sm font-medium">Issues</p>}
        table={
          <div
            role="alert"
            className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-bg)] p-4 text-sm text-[var(--error)]"
          >
            Could not load issues.
          </div>
        }
      />
    </ShellFrame>
  );
}

export function AppShellCollapsedFixture() {
  return (
    <ShellFrame state="collapsed">
      <AppShell
        density="compact"
        sidebar={
          <aside className="w-16 border-r border-[var(--border-default)] bg-[var(--bg-primary)] h-48" />
        }
      >
        <div className="p-6 text-sm text-[var(--text-muted)]">Collapsed sidebar rail</div>
      </AppShell>
    </ShellFrame>
  );
}

export function AppShellMobileFixture() {
  return (
    <ShellFrame state="mobile">
      <div className="relative pb-20">
        <div className="p-4 text-sm">Mobile list surface</div>
        <MobileBottomNav />
      </div>
    </ShellFrame>
  );
}

export function AppShellChatOpenFixture() {
  return (
    <ShellFrame state="loading">
      <AppShell
        density="comfortable"
        aiRail={
          <aside className="hidden lg:flex w-80 border-l border-[var(--border-default)] bg-[var(--bg-primary)] p-4 text-sm">
            ChatSidebar open
          </aside>
        }
      >
        <div className="p-6 text-sm text-[var(--text-muted)]">Main content with AI rail</div>
      </AppShell>
    </ShellFrame>
  );
}

export const U18_SHELL_FIXTURES = {
  loading: AppShellLoadingFixture,
  empty: AppShellEmptyFixture,
  error: AppShellErrorFixture,
  collapsed: AppShellCollapsedFixture,
  mobile: AppShellMobileFixture,
  chatOpen: AppShellChatOpenFixture,
} as const;
