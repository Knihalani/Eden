"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AlertChannel } from "@/lab/alert-destination";
import type { CompiledSignalDraft } from "@/lab/signal-compile";
import { useLabToast } from "@/lab/lab-toast";

export type SignalCompileJob = {
  id: string;
  prompt: string;
  agentId: string | null;
  notify: boolean;
  channel: AlertChannel;
  destination: string;
  severity: "auto" | "critical" | "error" | "warn";
  status: "compiling" | "ready" | "failed";
  draft?: CompiledSignalDraft;
  error?: string;
  createdAt: number;
};

type SignalJobsContextValue = {
  jobs: SignalCompileJob[];
  /** Ready drafts awaiting user verify/approve. */
  pendingReview: SignalCompileJob | null;
  /** Highlight Signals in the sidebar. */
  signalsNavAttention: boolean;
  startCompile: (input: {
    prompt: string;
    agentId: string | null;
    notify: boolean;
    channel: AlertChannel;
    destination: string;
    severity: "auto" | "critical" | "error" | "warn";
  }) => string;
  updatePendingDraft: (patch: Partial<CompiledSignalDraft>) => void;
  /** Promote a specific ready job to the front of the review queue. */
  focusReview: (jobId: string) => void;
  clearPendingReview: (jobId?: string) => void;
  clearSignalsNavAttention: () => void;
};

const SignalJobsContext = createContext<SignalJobsContextValue | null>(null);

export function SignalJobsProvider({ children }: { children: ReactNode }) {
  const { pushToast } = useLabToast();
  const [jobs, setJobs] = useState<SignalCompileJob[]>([]);
  const [signalsNavAttention, setSignalsNavAttention] = useState(false);

  const pendingReview = useMemo(
    () =>
      jobs.find((j) => j.status === "ready" && j.draft) ??
      null,
    [jobs],
  );

  const startCompile = useCallback(
    (input: {
      prompt: string;
      agentId: string | null;
      notify: boolean;
      channel: AlertChannel;
      destination: string;
      severity: "auto" | "critical" | "error" | "warn";
    }) => {
      const id = `job_${Date.now().toString(36)}`;
      const job: SignalCompileJob = {
        id,
        prompt: input.prompt,
        agentId: input.agentId,
        notify: input.notify,
        channel: input.channel,
        destination: input.destination,
        severity: input.severity,
        status: "compiling",
        createdAt: Date.now(),
      };
      setJobs((prev) => [job, ...prev]);

      pushToast({
        title: "Creating signal…",
        tone: "default",
      });

      void (async () => {
        try {
          const res = await fetch("/api/lab/compile-signal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: input.prompt }),
          });
          const data = (await res.json()) as {
            draft?: CompiledSignalDraft;
            detail?: string;
          };
          if (!res.ok || !data.draft) {
            throw new Error(data.detail || "Compile failed");
          }

          let draft = data.draft;
          if (input.severity !== "auto") {
            draft = { ...draft, severity: input.severity };
          }

          setJobs((prev) =>
            prev.map((j) =>
              j.id === id ? { ...j, status: "ready", draft } : j,
            ),
          );
          setSignalsNavAttention(true);
          pushToast({
            title: "Signal ready",
            body: draft.name,
            href: `/signals?review=${id}`,
            tone: "ok",
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Could not create signal";
          setJobs((prev) =>
            prev.map((j) =>
              j.id === id
                ? { ...j, status: "failed", error: message }
                : j,
            ),
          );
          pushToast({
            title: "Couldn't create signal",
            body: message,
            tone: "fail",
          });
        }
      })();

      return id;
    },
    [pushToast],
  );

  const updatePendingDraft = useCallback((patch: Partial<CompiledSignalDraft>) => {
    setJobs((prev) => {
      const target = prev.find((j) => j.status === "ready" && j.draft);
      if (!target?.draft) return prev;
      return prev.map((j) =>
        j.id === target.id
          ? { ...j, draft: { ...target.draft!, ...patch } }
          : j,
      );
    });
  }, []);

  const focusReview = useCallback((jobId: string) => {
    setJobs((prev) => {
      const idx = prev.findIndex(
        (j) => j.id === jobId && j.status === "ready" && j.draft,
      );
      if (idx <= 0) return prev;
      const next = [...prev];
      const [job] = next.splice(idx, 1);
      next.unshift(job);
      return next;
    });
  }, []);

  const clearPendingReview = useCallback((jobId?: string) => {
    setJobs((prev) =>
      prev.filter((j) => {
        if (j.status !== "ready" || !j.draft) return true;
        if (jobId) return j.id !== jobId;
        return false;
      }),
    );
    setSignalsNavAttention(false);
  }, []);

  const clearSignalsNavAttention = useCallback(() => {
    setSignalsNavAttention(false);
  }, []);

  const value = useMemo(
    () => ({
      jobs,
      pendingReview,
      signalsNavAttention,
      startCompile,
      updatePendingDraft,
      focusReview,
      clearPendingReview,
      clearSignalsNavAttention,
    }),
    [
      jobs,
      pendingReview,
      signalsNavAttention,
      startCompile,
      updatePendingDraft,
      focusReview,
      clearPendingReview,
      clearSignalsNavAttention,
    ],
  );

  return (
    <SignalJobsContext.Provider value={value}>
      {children}
    </SignalJobsContext.Provider>
  );
}

export function useSignalJobs() {
  const ctx = useContext(SignalJobsContext);
  if (!ctx) {
    throw new Error("useSignalJobs must be used within SignalJobsProvider");
  }
  return ctx;
}
