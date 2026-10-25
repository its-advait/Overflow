import { toFunctionSelector, type AbiFunction } from "viem";
import { describe, expect, it } from "vitest";
import { escrowEvents, eventSignature, EVENT_BY_TOPIC, factoryEvents, TRANSFER_TOPIC, treasuryAbi, treasuryEvents, usdcEvents } from "./abi.js";

// Pinned so a change to the built contracts shows up in review: the indexer, its handlers and the ledger
// posting rules read these exact argument shapes (no orderId on escrow events; the address is the order).
describe("event ABI (generated from the built contracts)", () => {
  it("treasury events", () => {
    expect(treasuryEvents.map(eventSignature)).toEqual([
      "NodeCreated(uint256,uint256,address,uint256,uint256,uint256)",
      "Paid(uint256,address,uint256,bytes32)",
      "Reserved(bytes32,uint256,address,uint256,uint256,bytes32)",
      "ReservationReleased(bytes32,bool)",
      "ReservationWindowSet(uint256)",
      "NodePaused(uint256,address)",
      "NodeUnpaused(uint256)",
      "CapRaised(uint256,uint256,uint256)",
      "AllowSet(address,bool)",
      "EscrowFactorySet(address)",
    ]);
  });
  it("factory and escrow events", () => {
    expect(factoryEvents.map(eventSignature)).toEqual([
      "OrderCreated(address,bytes32,address,address,uint256,bytes32)",
      "CheatRecorded(address,address)",
    ]);
    expect(escrowEvents.map(eventSignature)).toEqual([
      "OrderFunded(uint256)",
      "KeyRevealed(bytes32,uint64)",
      "Accepted(address,uint256)",
      "PaidOut(address,uint256,uint256)",
      "Refunded(string)",
      "CheatProven(address,uint256)",
      "Swept(address,uint256)",
    ]);
  });
  it("owner function selectors used for ControllerRequest calldata", () => {
    const wanted = ["setAllow", "raiseCap", "pause"];
    const fns = (treasuryAbi as readonly unknown[]).filter(
      (i): i is AbiFunction => (i as { type: string }).type === "function" && wanted.includes((i as AbiFunction).name),
    );
    const bySig = Object.fromEntries(fns.map((f) => [`${f.name}(${f.inputs.map((i) => i.type).join(",")})`, toFunctionSelector(f)]));
    expect(bySig).toEqual({
      "setAllow(address,bool)": "0xde6a0525",
      "raiseCap(uint256,uint256)": "0xf4f0fc21",
      "pause(uint256)": "0x136439dd",
    });
  });
  it("USDC Transfer (the only third-party event the indexer reads)", () => {
    expect(usdcEvents.map(eventSignature)).toEqual(["Transfer(address,address,uint256)"]);
    expect(TRANSFER_TOPIC).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });
  it("every selector is distinct and the Leash Paid selector is unchanged", () => {
    expect(EVENT_BY_TOPIC.size).toBe(20);
    // keccak256("Paid(uint256,address,uint256,bytes32)"), the selector Leash's LeashWallet emits.
    expect(EVENT_BY_TOPIC.get("0xa323b44195067cf7ba9a431c61b54b02673ff8142d227faabd075385ef9785e2")).toMatchObject({
      kind: "treasury",
      event: { name: "Paid" },
    });
  });
});
