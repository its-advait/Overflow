"use client";

import { useEffect, useState } from "react";

/** Client clock in unix seconds, ticking once a second. Use it only after data arrived, so there is no SSR mismatch. */
export function useNowSeconds(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
