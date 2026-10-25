"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { Waves } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV } from "./nav";

/**
 * On a dynamic route (/purchases/[id]) the pathname is request-time data under
 * cacheComponents, so the active-item highlight waits in a Suspense boundary and
 * the static shell renders the list without a highlight.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Suspense fallback={<NavList pathname={null} onNavigate={onNavigate} />}>
      <ActiveNav onNavigate={onNavigate} />
    </Suspense>
  );
}

function ActiveNav({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  return <NavList pathname={usePathname()} onNavigate={onNavigate} />;
}

function NavList({ pathname, onNavigate }: { pathname: string | null; onNavigate?: (() => void) | undefined }) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5 px-2">
      {NAV.map((item) => {
        const active = pathname !== null && (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href));
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              active ? "bg-surface-raised text-text" : "text-text-muted hover:bg-surface hover:text-text",
            )}
          >
            <Icon className={cn("size-4 shrink-0", active ? "text-cyan" : "")} aria-hidden />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function SidebarBrand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-4 py-5">
      <span className="grid size-8 place-items-center rounded-lg bg-blue/15 text-blue">
        <Waves className="size-4" aria-hidden />
      </span>
      <span className="text-base font-semibold tracking-tight">Overflow</span>
    </Link>
  );
}

/** Desktop sidebar: fixed column, hidden below lg. The drawer in the top bar covers narrow screens. */
export function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-canvas lg:flex">
      <SidebarBrand />
      <SidebarNav />
      <div className="mt-auto px-4 py-4 text-[11px] leading-relaxed text-text-muted">
        Agents propose. Only contracts move money.
      </div>
    </aside>
  );
}
