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
