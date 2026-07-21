"use client";

import { useState, useEffect, useCallback } from "react";
import { guardrailsApi } from "@/lib/api";
import { featureGatedMessage } from "@/lib/feature-flag-error";
import type {
  Policy,
  EvaluateResult,
  InjectionResult,
  RedactResult,
  TestResultKind,
  GuardrailsTab,
} from "./types";

type ScanRow = {
  id: string;
  trace_id: string | null;
  verdict: string;
  reason: string | null;
  created_at: string;
  edited_text: string | null;
};

export function useGuardrails(orgId: string | undefined, activeTab: GuardrailsTab) {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policiesLoading, setPoliciesLoading] = useState(true);
  const [policiesReady, setPoliciesReady] = useState(false);
  const [policiesError, setPoliciesError] = useState("");
  const [showAddPolicy, setShowAddPolicy] = useState(false);

  const [testContent, setTestContent] = useState("");
  const [evaluating, setEvaluating] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [redacting, setRedacting] = useState(false);
  const [evaluateResult, setEvaluateResult] = useState<EvaluateResult | null>(null);
  const [injectionResult, setInjectionResult] = useState<InjectionResult | null>(null);
  const [redactResult, setRedactResult] = useState<RedactResult | null>(null);
  const [activeResultKind, setActiveResultKind] = useState<TestResultKind | null>(null);
  const [testError, setTestError] = useState("");

  const [injectionHistory, setInjectionHistory] = useState<ScanRow[]>([]);
  const [piiHistory, setPiiHistory] = useState<ScanRow[]>([]);
  const [scanHistoryUnavailable, setScanHistoryUnavailable] = useState(false);
  const [scanHistoryError, setScanHistoryError] = useState("");

  const loadPolicies = useCallback(async () => {
    if (!orgId) return;
    setPoliciesLoading(true);
    setPoliciesError("");
    try {
      const data = await guardrailsApi.listPolicies(orgId);
      setPolicies(data.policies ?? []);
    } catch (err) {
      setPoliciesError(featureGatedMessage(err, "Failed to load policies"));
    } finally {
      setPoliciesLoading(false);
      setPoliciesReady(true);
    }
  }, [orgId]);

  useEffect(() => {
    if (orgId) void loadPolicies();
  }, [orgId, loadPolicies]);

  const loadScanHistory = useCallback(async () => {
    if (!orgId) return;
    setScanHistoryUnavailable(false);
    setScanHistoryError("");
    try {
      const [inj, pii] = await Promise.all([
        guardrailsApi.scanHistory(orgId, { limit: 50, action_prefix: "injection" }),
        guardrailsApi.scanHistory(orgId, { limit: 50, action_prefix: "pii" }),
      ]);
      setInjectionHistory(
        (inj.scans ?? []).map((s) => ({
          id: s.id,
          trace_id: s.trace_id,
          verdict: s.verdict,
          reason: s.reason,
          created_at: s.created_at,
          edited_text: null,
        })),
      );
      setPiiHistory(
        (pii.scans ?? []).map((s) => ({
          id: s.id,
          trace_id: s.trace_id,
          verdict: s.verdict,
          reason: s.reason,
          created_at: s.created_at,
          edited_text: s.edited_text ?? null,
        })),
      );
    } catch (e) {
      setInjectionHistory([]);
      setPiiHistory([]);
      setScanHistoryUnavailable(true);
      setScanHistoryError(featureGatedMessage(e, "Failed to load scan history"));
    }
  }, [orgId]);

  useEffect(() => {
    if (orgId && (activeTab === "injections" || activeTab === "pii")) {
      void loadScanHistory();
    }
  }, [orgId, activeTab, loadScanHistory]);

  const clearResults = () => {
    setEvaluateResult(null);
    setInjectionResult(null);
    setRedactResult(null);
    setActiveResultKind(null);
  };

  async function handleEvaluate() {
    if (!orgId || !testContent.trim()) return;
    setEvaluating(true);
    setTestError("");
    clearResults();
    try {
      const data = await guardrailsApi.evaluate(orgId, { text: testContent });
      setEvaluateResult(data);
      setActiveResultKind("evaluate");
    } catch (err) {
      setTestError(featureGatedMessage(err, "Evaluation failed"));
    } finally {
      setEvaluating(false);
    }
  }

  async function handleInjectionScan() {
    if (!orgId || !testContent.trim()) return;
    setScanning(true);
    setTestError("");
    clearResults();
    try {
      const data = await guardrailsApi.scanInjection(orgId, { text: testContent });
      setInjectionResult(data);
      setActiveResultKind("injection");
    } catch (err) {
      setTestError(featureGatedMessage(err, "Injection scan failed"));
    } finally {
      setScanning(false);
    }
  }

  async function handleRedact() {
    if (!orgId || !testContent.trim()) return;
    setRedacting(true);
    setTestError("");
    clearResults();
    try {
      const data = await guardrailsApi.redactPii(orgId, { text: testContent });
      setRedactResult(data);
      setActiveResultKind("redact");
    } catch (err) {
      setTestError(featureGatedMessage(err, "Redaction failed"));
    } finally {
      setRedacting(false);
    }
  }

  return {
    policies,
    policiesLoading,
    policiesReady,
    policiesError,
    showAddPolicy,
    setShowAddPolicy,
    loadPolicies,
    testContent,
    setTestContent,
    evaluating,
    scanning,
    redacting,
    evaluateResult,
    injectionResult,
    redactResult,
    activeResultKind,
    testError,
    handleEvaluate,
    handleInjectionScan,
    handleRedact,
    injectionHistory,
    piiHistory,
    scanHistoryUnavailable,
    scanHistoryError,
    loadScanHistory,
  };
}
