import type { Address } from "viem";
import type { Deployments } from "@overflow/schemas";
import type { ChainClient } from "../chain/client";
import type { Bus } from "./events";
import type { Relayer } from "./relayer";
import type { Store } from "./store";

/** Everything the routes need, injected so tests pass fakes. */
export type FacilitatorDeps = {
  client: ChainClient;
  relayer: Relayer;
  store: Store;
  bus: Bus;
  deployments: Deployments;
  treasury: Address;
  usdc: Address;
  demoMode: boolean;
  demoToken?: string;
  now: () => Date;
  log: (line: string) => void;
};
