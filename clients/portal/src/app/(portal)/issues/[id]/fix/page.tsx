"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, Loader2, Send, Wrench } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { agentIssuesApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { Skeleton } from "@/components/ui/skeleton";

export default function IssueFixPage() {
  const { currentOrg } = useOrg();
  const params = useParams<{ id: string }>();
  const issueId = params?.id;
  const toast = useToast();

  const [message, setMessage] = useState("");
  const [repo, setRepo] = useState("");
  const [patch, setPatch] = useState<string | null>(null);
  const [chatLog, setChatLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const loadSession = useCallback(async () => {
    if (!currentOrg || !issueId) return;
    setSessionLoading(true);
    try {
      const [sessionRes, issueRes] = await Promise.all([
        agentIssuesApi.fixSession(currentOrg.id, issueId),
        agentIssuesApi.get(currentOrg.id, issueId).catch(() => null),
      ]);
      const s = sessionRes.data?.session as {
        status?: string;
        proposed_patch?: string;
        repo_full_name?: string;
        messages?: Array<{ role: string; content: string }>;
      } | undefined;
      if (s) {
        setSessionStatus(s.status ?? null);
        if (s.proposed_patch) setPatch(s.proposed_patch);
        if (s.repo_full_name && !repo) setRepo(s.repo_full_name);
        if (s.messages?.length) {
          setChatLog(
            s.messages.map((m) =>
              m.role === "user" ? `You: ${m.content}` : `Eden: ${m.content}`,
            ),
          );
        }
      }
      const issue = issueRes?.data?.issue;
      if (issue?.agent_id && !repo) {
        setRepo(`${currentOrg.slug ?? currentOrg.id}/${issue.agent_id}`);
      }
    } catch {
      // no session yet
    } finally {
      setSessionLoading(false);
    }
  }, [currentOrg, issueId, repo]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const onSend = async () => {
    if (!currentOrg || !issueId || !message.trim() || !repo.trim()) {
      toast.error("Enter a message and repo (org/repo)");
      return;
    }
    setBusy(true);
    setChatLog((prev) => [...prev, `You: ${message}`]);
    try {
      const stream = await agentIssuesApi.fixChatStream(
        currentOrg.id,
        issueId,
        { message, repo_full_name: repo },
      );
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const block of parts) {
          const lines = block.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (!data) continue;
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (event === "token" && typeof parsed.text === "string") {
            setChatLog((prev) => [...prev, parsed.text as string]);
          }
          if (event === "tool_call") {
            const tool = typeof parsed.tool === "string" ? parsed.tool : "tool";
            const path = typeof parsed.path === "string" ? parsed.path : parsed.query;
            setChatLog((prev) => [
              ...prev,
              `→ ${tool}${path ? ` (${String(path)})` : ""}`,
            ]);
          }
          if (event === "patch_proposed" && typeof parsed.patch === "string") {
            setPatch(parsed.patch);
            setSessionStatus("patch_proposed");
          }
          if (event === "done" && typeof parsed.status === "string") {
            setSessionStatus(parsed.status);
          }
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Chat failed");
    } finally {
      setBusy(false);
      setMessage("");
    }
  };

  const onApply = async () => {
    if (!currentOrg || !issueId) return;
    setBusy(true);
    try {
      const res = await agentIssuesApi.fixApply(currentOrg.id, issueId, { confirm: true });
      const data = (res.data ?? {}) as {
        ok?: boolean;
        reason?: string;
        session?: { status?: string };
        pr_url?: string;
      };
      if (data.ok) {
        toast.success("Patch applied");
        setSessionStatus(data.session?.status ?? "applied");
        if (data.pr_url) toast.success(`PR: ${data.pr_url}`);
      } else {
        toast.error(String(data.reason ?? "Apply failed"));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Apply failed");
    } finally {
      setBusy(false);
      await loadSession();
    }
  };

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [chatLog]);

  if (!currentOrg) return null;

  if (sessionLoading) {
    return (
      <PageContent size="wide">
        <Skeleton className="h-4 w-32 mb-4" />
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[420px] rounded-xl" />
          <Skeleton className="h-[420px] rounded-xl" />
        </div>
      </PageContent>
    );
  }

  return (
    <PageContent size="wide">
      <Link
        href={`/issues/${issueId}`}
        className="inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] mb-4 min-h-[44px]"
      >
        <ArrowLeft className="h-4 w-4" /> Back to issue
      </Link>

      <div className="flex items-center gap-2 mb-4">
        <Wrench className="h-5 w-5 text-[var(--accent)]" />
        <h1 className="text-lg font-semibold">Fix in code</h1>
        {sessionStatus && (
          <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
            {sessionStatus}
          </span>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2 min-h-[480px]">
        <Card padding="md" className="flex flex-col min-h-[420px]">
          <label className="text-xs text-[var(--text-muted)] mb-1">Repository (org/repo)</label>
          <input
            className="mb-3 w-full rounded border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2.5 text-sm min-h-[44px]"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="acme/checkout-agent"
          />
          <pre
            ref={logRef}
            className="flex-1 overflow-auto rounded bg-[var(--bg-tertiary)] p-3 text-xs font-mono text-[var(--text-secondary)] mb-3 min-h-[200px]"
          >
            {chatLog.length === 0 ? "Describe the fix you want…" : chatLog.join("")}
          </pre>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2.5 text-sm min-h-[44px]"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Fix the loop in checkout prompt…"
              onKeyDown={(e) => e.key === "Enter" && !busy && void onSend()}
            />
            <Button size="sm" disabled={busy} onClick={() => void onSend()} className="min-h-[44px] min-w-[44px]">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </Card>

        <Card padding="md" className="flex flex-col min-h-[420px]">
          <h2 className="text-sm font-semibold mb-2">Proposed diff</h2>
          <pre className="flex-1 overflow-auto rounded bg-[var(--bg-tertiary)] p-3 text-[11px] font-mono text-[var(--text-secondary)] min-h-[280px]">
            {patch ?? "No patch proposed yet."}
          </pre>
          <Button
            className="mt-3 min-h-[44px]"
            disabled={busy || !patch}
            onClick={() => void onApply()}
          >
            Apply patch & open PR
          </Button>
        </Card>
      </div>
    </PageContent>
  );
}
