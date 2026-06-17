"use client";

/**
 * Common UI primitives — EmptyState, Skeleton, ErrorBoundary.
 *
 * Used by every observability page to give a consistent
 * loading / empty / error UX. The components are pure
 * presentational; the parent decides when to render which.
 */

import * as React from "react";
import { useState } from "react";
import { cn } from "@/lib/utils";


// ── EmptyState ────────────────────────────────────────────


export interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cn(
      "flex flex-col items-center justify-center gap-2 rounded border border-dashed border-[var(--border)] p-8 text-center",
      className,
    )}>
      {icon && <div className="text-2xl text-[var(--text-muted)]">{icon}</div>}
      {title && <h3 className="text-sm font-medium text-[var(--text-primary)]">{title}</h3>}
      {description && <p className="max-w-sm text-xs text-[var(--text-muted)]">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}


// ─- Skeleton ──────────────────────────────────────────────


export interface SkeletonProps {
  className?: string;
  // Width / height in pixels (defaults: 100% wide, 16px tall).
  width?: number | string;
  height?: number | string;
}

export function Skeleton({ className, width, height }: SkeletonProps) {
  return (
    <div
      className={cn("animate-pulse rounded bg-[var(--bg-secondary)]", className)}
      style={{
        width: width ?? "100%",
        height: height ?? 16,
      }}
    />
  );
}


// ─- ErrorBoundary ───────────────────────────────────────────


interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (this.props.fallback) {
      return this.props.fallback(error, this.reset);
    }
    return (
      <div className="rounded border border-[var(--error)] bg-[var(--bg-primary)] p-4">
        <h3 className="text-sm font-medium text-[var(--error)]">Something went wrong</h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{error.message}</p>
        <button
          onClick={this.reset}
          className="mt-2 rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-primary)]"
        >
          Try again
        </button>
      </div>
    );
  }
}


// ─- Loading (spinner + label) ──────────────────────────────


export interface LoadingProps {
  label?: string;
  className?: string;
}

export function Loading({ label, className }: LoadingProps) {
  return (
    <div className={cn("flex items-center gap-2 text-xs text-[var(--text-muted)]", className)}>
      <svg
        className="h-3 w-3 animate-spin"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle cx="12" cy="12" r="10" stroke="var(--text-muted)" strokeWidth="2" opacity="0.3" />
        <path
          d="M12 2a10 10 0 0 1 10 10"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      {label ?? "Loading…"}
    </div>
  );
}
