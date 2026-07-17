"use client";

import * as React from "react";
import { TranscriptV2, type TranscriptV2Props } from "./TranscriptV2";

/**
 * N13 progressive transcript — thin alias over TranscriptV2 orchestrator.
 */
export type VirtualizedTranscriptProps = TranscriptV2Props;

export function VirtualizedTranscript(props: VirtualizedTranscriptProps) {
  return <TranscriptV2 {...props} />;
}
