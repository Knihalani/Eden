"use client";

import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "./button";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional custom fallback. */
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Classic React error boundary. Catches render-time errors in the subtree
 * and renders a styled terminal-style fallback instead of a white screen.
 *
 * Usage:
 *   <ErrorBoundary><YourTree /></ErrorBoundary>
 *   <ErrorBoundary fallback={<CustomUI />}>...</ErrorBoundary>
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log to console so devs can see it; the real telemetry hooks go elsewhere.
     
    console.error("[ErrorBoundary] Caught:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          role="alert"
          className="min-h-[400px] flex flex-col items-center justify-center p-8 text-center space-y-4"
        >
          <div className="p-3 rounded-full bg-[var(--error-dim)] text-[var(--error)]">
            <AlertTriangle className="w-8 h-8" aria-hidden />
          </div>
          <div className="space-y-2 max-w-md">
            <h2 className="text-xl font-semibold text-[var(--text-primary)]">
              Something went wrong
            </h2>
            <p className="text-sm text-[var(--text-secondary)]">
              {this.state.error?.message || "An unexpected error occurred."}
            </p>
            {process.env.NODE_ENV === "development" && this.state.error?.stack && (
              <pre className="text-left text-xs font-mono text-[var(--text-muted)] bg-[var(--bg-base)] border border-[var(--border-default)] rounded-md p-3 overflow-x-auto max-h-48">
                {this.state.error.stack}
              </pre>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={this.handleReset}>
              Try again
            </Button>
            <Button onClick={this.handleReload}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Reload page
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
