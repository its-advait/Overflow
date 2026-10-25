import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ScriptedStatus } from "./scripted-status";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar slot={<ScriptedStatus />} />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}
