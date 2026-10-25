"use client";

import { useCallback, useEffect, useState, type DependencyList } from "react";

export interface ApiQueryState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** Re-run the query. */
  reload: () => void;
}

type Settled<T> = { key: string; data?: T; error?: Error };

/**
 * Minimal client-side query hook for the typed api client. `loading` is derived
 * from whether the latest request key has settled, so a page renders Skeleton,
 * ErrorState or data and never a result that did not come back from the call.
 */
export function useApiQuery<T>(fn: () => Promise<T>, deps: DependencyList): ApiQueryState<T> {
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>({ key: "" });
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // Plain string: a change in deps or a reload yields a new key, and only that key's result is shown.
  const key = `${tick}:${JSON.stringify(deps)}`;

  useEffect(() => {
    let cancelled = false;
    fn().then(
      (data) => {
        if (!cancelled) setSettled({ key, data });
      },
      (e: unknown) => {
        if (!cancelled) setSettled({ key, error: e instanceof Error ? e : new Error(String(e)) });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = settled.key === key;
  return {
    data: current ? settled.data : undefined,
    error: current ? settled.error : undefined,
    loading: !current,
    reload,
  };
}

/**
 * Keeps the last defined value for a key while a refetch is in flight, so a list refreshed on every
 * feed event does not flash back to its skeleton. A new key drops the kept value (a different node's
 * panel starts empty). Only real results are ever kept: an error or a pending query leaves `undefined`.
 */
export function useLastGood<T>(value: T | undefined, key: unknown = null): T | undefined {
  const [kept, setKept] = useState<{ key: unknown; value: T | undefined }>({ key, value });
  // "Storing information from previous renders" (react.dev): a guarded setState during render, no effect.
  if (value !== undefined && (kept.value !== value || kept.key !== key)) setKept({ key, value });
  if (value !== undefined) return value;
  return kept.key === key ? kept.value : undefined;
}
