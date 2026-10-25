"use client";

import { useEffect, useState } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { SkeletonRows } from "@/components/shared/skeleton";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import { useApiQuery, useLastGood } from "@/lib/use-api";
import { CapsPanel } from "./caps-panel";
import { FusionPanel } from "./fusion-panel";
import { ListingsPanel } from "./listings-panel";
import { NetworkPanel } from "./network-panel";
import { SellersPanel } from "./sellers-panel";

/** Feed kinds after which the page re-reads: an order's chain events, a controller request's life, a node change. */
const RELOAD_PREFIXES = ["escrow.", "purchase.", "controller.", "treasury.", "seller."];

/**
 * /settings: the judge's own scenario (docs/SPEC.md). Five panels, each over the service's answers only:
 * SIMULATED sellers (behaviour per seller, run one order), SIMULATED listings (price, license, seats), the Fusion
 * check, agent caps and payees (controller requests), network and contracts. Every write re-reads the rows the
 * service returned; no panel shows a success the chain or the service did not report.
 */
export function SettingsView() {
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);
  const sellers = useApiQuery(() => api.listSellers(), [tick]);
  const resources = useApiQuery(() => api.listResources(), [tick]);
  const missions = useApiQuery(() => api.listMissions(), [tick]);
  const nodes = useApiQuery(() => api.listTreasuryNodes(), [tick]);
  const requests = useApiQuery(() => api.listControllerRequests({ status: "all" }), [tick]);
  const network = useApiQuery(() => api.getNetwork(), [tick]);
  const treasury = useApiQuery(() => api.status(), []);

  const sellerRows = useLastGood(sellers.data?.sellers);
  const listingRows = useLastGood(resources.data?.resources);
  const missionRows = useLastGood(missions.data?.missions);
  const nodeRows = useLastGood(nodes.data?.nodes);
  const requestRows = useLastGood(requests.data?.requests);
  const networkInfo = useLastGood(network.data);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.subscribe((m) => {
      if (m.type !== "activity") return;
      if (!RELOAD_PREFIXES.some((p) => m.event.kind.startsWith(p))) return;
      clearTimeout(timer);
      timer = setTimeout(reload, 300);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const treasuryAddress = typeof treasury.data?.["treasury"] === "string" ? (treasury.data["treasury"] as string) : (nodes.data?.treasury ?? null);

  return (
    <div className="flex flex-col gap-6">
      {sellerRows ? (
        <SellersPanel sellers={sellerRows} listings={listingRows ?? []} treasury={treasuryAddress} onChanged={reload} />
      ) : sellers.error ? (
        <ErrorState error={sellers.error} title={sellers.error instanceof ApiError && sellers.error.status === 501 ? "Seller controls need the local Anvil fork" : "Could not read the sellers"} />
      ) : (
        <SkeletonRows rows={3} />
      )}
      {listingRows ? <ListingsPanel listings={listingRows} onChanged={reload} /> : resources.error ? <ErrorState error={resources.error} title="Could not read the listings" /> : <SkeletonRows rows={4} />}
      {missionRows ? <FusionPanel missions={missionRows} /> : missions.error ? <ErrorState error={missions.error} title="Could not read the missions" /> : <SkeletonRows rows={2} />}
      {nodeRows ? (
        <CapsPanel nodes={nodeRows} requests={requestRows ?? []} onChanged={reload} />
      ) : nodes.error ? (
        <ErrorState error={nodes.error} title="Could not read the treasury nodes" />
      ) : (
        <SkeletonRows rows={2} />
      )}
      {networkInfo ? <NetworkPanel info={networkInfo} /> : network.error ? <ErrorState error={network.error} title="Could not read the network" /> : <SkeletonRows rows={3} />}
    </div>
  );
}
