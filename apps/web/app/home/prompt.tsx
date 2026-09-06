"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AccountCopy } from "../account/frame";
import { HOME } from "../account/home";
import { filledPrompt } from "./prompt-actions";
import { envHasSecrets, setupPrompt, type PromptEnv } from "./prompt-text";

export function SetupPrompt({ placeholders }: { placeholders: PromptEnv }) {
  return (
    <section className="account-stage account-stage-prompt">
      <AccountCopy title="Copy this into your agent" lead="Paste it into the agent you already run. After it wraps, requests show up on Home." wide />
      <SetupBlock placeholders={placeholders} />
      <p className="setup-next">
        <Link href={HOME} prefetch={true}>
          Go to Home
        </Link>
      </p>
    </section>
  );
}

export function SetupBlock({ placeholders }: { placeholders: PromptEnv }) {
  const [useFilled, setUseFilled] = useState(false);
  const [filled, setFilled] = useState<PromptEnv | null>(null);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [keyError, setKeyError] = useState("");
  const preRef = useRef<HTMLPreElement>(null);
  const env = useFilled && filled ? filled : placeholders;
  const text = setupPrompt(env);
  const secrets = envHasSecrets(env);

  const loadKeys = useCallback(async () => {
    setUseFilled(true);
    setKeyError("");
    if (filled) return;
    setLoadingKeys(true);
    try {
      const next = await filledPrompt();
      if (!envHasSecrets(next)) {
        setKeyError("Couldn’t load your key. Stay on placeholders or try again.");
        setUseFilled(false);
        return;
      }
      setFilled(next);
    } catch {
      setKeyError("Couldn’t load your key. Stay on placeholders or try again.");
      setUseFilled(false);
    } finally {
      setLoadingKeys(false);
    }
  }, [filled]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      const node = preRef.current;
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopied("fail");
    }
  }, [text]);

  useEffect(() => {
    setCopied("idle");
  }, [useFilled, text]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
      event.preventDefault();
      void onCopy();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCopy]);

  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), 2200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyLabel =
    copied === "ok"
      ? secrets
        ? "Copied · includes your key"
        : "Copied"
      : copied === "fail"
        ? "Couldn’t copy"
        : "Copy";

  const live =
    copied === "ok"
      ? secrets
        ? "Copied. The paste includes your key."
        : "Copied."
      : copied === "fail"
        ? "Couldn’t copy. The prompt is selected — copy it from there."
        : loadingKeys
          ? "Loading your key."
          : "";

  return (
    <>
      <div className="setup">
        <div className="setup-bar">
          <div className="seg" role="radiogroup" aria-label="Environment values">
            <button
              type="button"
              role="radio"
              aria-checked={!useFilled}
              tabIndex={useFilled ? -1 : 0}
              onClick={() => setUseFilled(false)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "ArrowDown") {
                  event.preventDefault();
                  void loadKeys();
                }
              }}
            >
              Placeholders
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={useFilled}
              tabIndex={useFilled ? 0 : -1}
              onClick={() => void loadKeys()}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setUseFilled(false);
                }
              }}
            >
              {loadingKeys ? "Loading keys" : "With keys"}
            </button>
          </div>
          <button
            className="copy-btn setup-copy"
            type="button"
            onClick={() => void onCopy()}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            disabled={loadingKeys}
          >
            {copyLabel}
          </button>
        </div>
        {useFilled ? (
          <p className="setup-notice" role="status">
            This paste includes your workspace key. Do not commit it.
          </p>
        ) : (
          <p className="setup-notice setup-notice-quiet" role="status">
            Placeholders until you choose With keys.
          </p>
        )}
        <pre ref={preRef} tabIndex={0} aria-label="Setup prompt">
          <code>{loadingKeys && useFilled ? setupPrompt(placeholders) : text}</code>
        </pre>
        <p className="sr-only" aria-live="polite">
          {live}
        </p>
      </div>
      {keyError ? (
        <p className="account-error" role="alert">
          {keyError}
        </p>
      ) : null}
      {copied === "fail" ? (
        <p className="account-error" role="alert">
          Couldn’t copy. The prompt is selected — copy it from there.
        </p>
      ) : null}
    </>
  );
}
