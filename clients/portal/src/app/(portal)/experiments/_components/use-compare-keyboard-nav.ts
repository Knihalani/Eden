"use client";

import { useCallback, useMemo } from "react";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { sortDatapointsFailingFirst } from "./compare-grades";
import type { Datapoint } from "./types";

function datapointKey(dp: Datapoint, idx: number): string {
  return String(dp.row_id || idx);
}

/**
 * j/k + arrows among compare datapoints (failing-first order).
 * Selecting an index opens that row's diff panel.
 */
export function useCompareKeyboardNav(
  datapoints: Datapoint[],
  diffOpen: string | null,
  onSetDiffOpen: (key: string | null) => void,
  enabled: boolean,
): void {
  const sorted = useMemo(
    () => sortDatapointsFailingFirst(datapoints),
    [datapoints],
  );
  const keys = useMemo(
    () => sorted.map((dp, idx) => datapointKey(dp, idx)),
    [sorted],
  );
  const selectedIndex = useMemo(() => {
    if (!diffOpen) return 0;
    const i = keys.indexOf(diffOpen);
    return i >= 0 ? i : 0;
  }, [diffOpen, keys]);

  const onSelectIndex = useCallback(
    (index: number) => {
      const key = keys[index];
      if (key != null) onSetDiffOpen(key);
    },
    [keys, onSetDiffOpen],
  );

  useListKeyboardNav(
    keys.length,
    selectedIndex,
    onSelectIndex,
    enabled && keys.length > 0,
  );
}
