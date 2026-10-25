"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** "Copied" appears only after the clipboard promise resolves. */
export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      aria-label={state === "copied" ? "Copied" : label}
      title={state === "failed" ? "Clipboard unavailable" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-raised hover:text-text",
        state === "copied" && "text-success",
        state === "failed" && "text-danger",
        className,
      )}
    >
      {state === "copied" ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}
