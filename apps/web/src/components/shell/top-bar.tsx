"use client";

import { useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { MockBadge } from "./mock-badge";
import { NetworkBadge } from "./network-badge";
import { SidebarBrand, SidebarNav } from "./sidebar";
import { TreasuryBalance } from "./treasury-balance";

/** `slot` is reserved for the SCRIPTED badge; the shell fills it from the environment. */
export function TopBar({ slot }: { slot?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-canvas/85 px-4 backdrop-blur supports-backdrop-filter:bg-canvas/70 sm:px-6">
      <Button
        variant="ghost"
        size="icon-sm"
        className="lg:hidden"
        aria-label="Open navigation"
        onClick={() => setOpen(true)}
      >
        <Menu />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-64 p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarBrand />
          <SidebarNav onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex items-center gap-2">
        <NetworkBadge />
        <MockBadge />
        {slot}
      </div>

      <div className="ml-auto">
        <TreasuryBalance />
      </div>
    </header>
  );
}
