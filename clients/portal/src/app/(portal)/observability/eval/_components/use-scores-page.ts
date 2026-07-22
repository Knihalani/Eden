"use client";

import { useState } from "react";
import { useOrg } from "@/hooks/use-org";

export const WAVE_E5_SCORES_COMPLETED = true;

export type ScoresTab = "versions" | "clusters";

export function useScoresPage() {
  const { currentOrg } = useOrg();
  const embedded = false;
  const [activeTab, setActiveTab] = useState<ScoresTab>("versions");
  const [error, setError] = useState("");

  return {
    currentOrg,
    embedded,
    activeTab,
    setActiveTab,
    error,
    setError,
  };
}
