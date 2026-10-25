import { NetworkInfoSchema } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import { viemNetworkInfo } from "./network-info.js";

const TREASURY = "0x1111111111111111111111111111111111111111";
const OWNER = "0xB6F4d7B4c2d4B2cC5A5a7e9E8f1C2d3E4f5A06C3";

describe("viemNetworkInfo", () => {
  it("reads owner, floor, reservationWindow, reservedTotal and nodeCount at one block and labels the network", async () => {
    const calls: string[] = [];
    const answers: Record<string, unknown> = { owner: OWNER, floor: 5_000_000n, reservationWindow: 600n, reservedTotal: 12_000_000n, nodeCount: 4n };
    const port = viemNetworkInfo({
      chain: {
        getBlockNumber: async () => 49_900_000n,
        readContract: async ({ functionName, blockNumber }) => {
          calls.push(`${functionName}@${blockNumber}`);
          return answers[functionName];
        },
      },
      chainId: 84532,
      anvil: true,
      rpcHost: "http://127.0.0.1:8545",
      treasury: TREASURY,
      escrowFactory: null,
      token: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2", decimals: 6, domainSeparator: "0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818" },
      relayer: "0x2222222222222222222222222222222222222222",
      deployments: { deployBlock: "49000000" },
      now: () => new Date("2026-10-25T12:00:00.000Z"),
    });
    const info = await port.read();
    expect(NetworkInfoSchema.parse(info)).toEqual(info);
    expect(info).toMatchObject({ network: "local Anvil fork", owner: OWNER, floorAtomic: "5000000", reservationWindowSeconds: "600", reservedTotalAtomic: "12000000", nodeCount: "4", blockNumber: "49900000", deployBlock: "49000000", escrowFactory: null });
    expect(info).not.toHaveProperty("deployedAt");
    expect(calls.sort()).toEqual(["floor@49900000", "nodeCount@49900000", "owner@49900000", "reservationWindow@49900000", "reservedTotal@49900000"]);
  });
});
