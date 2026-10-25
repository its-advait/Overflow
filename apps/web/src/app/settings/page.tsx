import { Suspense } from "react";
import { SettingsView } from "@/components/settings/settings-view";
import { SkeletonRows } from "@/components/shared/skeleton";
import { NAV } from "@/components/shell/nav";
import { PageHeader } from "@/components/shell/page-header";

const item = NAV.find((n) => n.href === "/settings")!;

/** Settings: the judge's own scenario. Seller behaviour, listing price and license, Fusion check, caps and payees, network. */
export default function SettingsPage() {
  return (
    <>
      <PageHeader title={item.label} description={item.description} />
      <Suspense fallback={<SkeletonRows rows={6} />}>
        <SettingsView />
      </Suspense>
    </>
  );
}
