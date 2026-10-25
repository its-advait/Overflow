import { Construction } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { NAV } from "./nav";
import { PageHeader } from "./page-header";

/** Placeholder for a nav item whose real page lands in a later prompt. Shows nothing it cannot back up. */
export function PlaceholderPage({ href }: { href: string }) {
  const item = NAV.find((n) => n.href === href);
  if (!item) throw new Error(`no nav item for ${href}`);
  return (
    <>
      <PageHeader title={item.label} description={item.description} />
      <EmptyState
        icon={Construction}
        title={`${item.label} is not built yet`}
        description="This page will read only confirmed chain events and real service responses. Until then it shows nothing."
      />
    </>
  );
}
