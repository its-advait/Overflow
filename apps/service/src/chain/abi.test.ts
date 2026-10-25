import { toFunctionSelector, type AbiFunction } from "viem";
import { describe, expect, it } from "vitest";
import { escrowEvents, eventSignature, EVENT_BY_TOPIC, factoryEvents, TRANSFER_TOPIC, treasuryAbi, treasuryEvents, usdcEvents } from "./abi.js";

// Pinned so a change to the provisional ABI shows up in review. The contract
// author must emit these signatures or edit abi.ts and this snapshot together.
describe("provisional event ABI", () => {
  it("treasury events", () => {
    expect(treasuryEvents.map(eventSignature)).toEqual([
      "NodeCreated(uint256,uint256,address,uint256,uint256,uint256)",
      "Paid(uint256,address,uint256,bytes32)",
      "NodePaused(uint256,address)",
      "NodeUnpaused(uint256)",
      "CapRaised(uint256,uint256,uint256)",
      "AllowSet(address,bool)",
      "Reserved(bytes32,uint256,address,uint256,uint256,bytes32)",
      "ReservationReleased(bytes32,uint256,uint256,bool)",
      "EscrowFactorySet(address)",
    ]);
  });
  it("factory and escrow events", () => {
    expect(factoryEvents.map(eventSignature)).toEqual([
      "OrderCreated(bytes32,address,address,address,uint256,uint256,bytes32)",
    ]);
    expect(escrowEvents.map(eventSignature)).toEqual([
      "OrderFunded(bytes32,uint256)",
      "KeyRevealed(bytes32,bytes32)",
      "Accepted(bytes32,address)",
      "PaidOut(bytes32,address,uint256,uint256)",
      "Refunded(bytes32,uint256,string)",
      "CheatProven(address,uint256)",
      "BondForfeited(bytes32,address,uint256)",
    ]);
  });
  it("owner function selectors used for ControllerRequest calldata", () => {
    const fns = (treasuryAbi as readonly unknown[]).filter((i): i is AbiFunction => (i as { type: string }).type === "function");
    expect(fns.map((f) => `${f.name}(${f.inputs.map((i) => i.type).join(",")})`)).toEqual([
      "setAllow(address,bool)",
      "raiseCap(uint256,uint256)",
      "pause(uint256)",
    ]);
    expect(fns.map(toFunctionSelector)).toEqual(["0xde6a0525", "0xf4f0fc21", "0x136439dd"]);
  });
  it("USDC Transfer (the only third-party event the indexer reads)", () => {
    expect(usdcEvents.map(eventSignature)).toEqual(["Transfer(address,address,uint256)"]);
    expect(TRANSFER_TOPIC).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });
  it("every selector is distinct and the Leash Paid selector is unchanged", () => {
    expect(EVENT_BY_TOPIC.size).toBe(18);
    // keccak256("Paid(uint256,address,uint256,bytes32)"), the selector Leash's LeashWallet emits.
    expect(EVENT_BY_TOPIC.get("0xa323b44195067cf7ba9a431c61b54b02673ff8142d227faabd075385ef9785e2")).toMatchObject({
      kind: "treasury",
      event: { name: "Paid" },
    });
  });
});
