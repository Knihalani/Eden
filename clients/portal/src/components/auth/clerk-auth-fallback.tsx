"use client";

import { useEffect } from "react";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

/** Clerk's dev-mode strip paints a square gold fill that clips card corners. */
function hideClerkDevDecor(root: HTMLElement) {
  root.querySelectorAll("*").forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    const bg = getComputedStyle(node).backgroundColor;
    // Clerk warning gold (#D4B06E)
    if (bg === "rgb(212, 176, 110)") {
      node.style.setProperty("display", "none", "important");
    }
    if (
      node.childElementCount === 0 &&
      node.textContent?.trim() === "Development mode"
    ) {
      const item = node.closest(".cl-footerItem");
      if (item instanceof HTMLElement) {
        item.style.setProperty("display", "none", "important");
      } else {
        node.style.setProperty("display", "none", "important");
      }
    }
  });
}

export function ClerkAuthFallback({
  formLabel,
  children,
}: {
  formLabel: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(
      `[data-auth-form="${formLabel}"] .auth-card`,
    );
    if (!root) return;

    hideClerkDevDecor(root);
    const observer = new MutationObserver(() => hideClerkDevDecor(root));
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [formLabel]);

  return (
    <div data-auth-form={formLabel} className="w-full">
      {/* Own the card chrome — Clerk renders transparent inside so corners don't clip. */}
      <div className="auth-card">{children}</div>
      <p className="type-meta mt-5 text-center">
        Trouble signing in?{" "}
        <a href={DOCS_QUICKSTART_URL} className="ds-link">
          Docs
        </a>
      </p>
    </div>
  );
}
