import { describe, expect, it } from "vitest";
import { escrowEvents, eventSignature, EVENT_BY_TOPIC, factoryEvents, treasuryEvents } from "./abi.js";

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
    ]);
  });
  it("every selector is distinct and the Leash Paid selector is unchanged", () => {
    expect(EVENT_BY_TOPIC.size).toBe(16);
    // keccak256("Paid(uint256,address,uint256,bytes32)"), the selector Leash's LeashWallet emits.
    expect(EVENT_BY_TOPIC.get("0xa323b44195067cf7ba9a431c61b54b02673ff8142d227faabd075385ef9785e2")).toMatchObject({
      kind: "treasury",
      event: { name: "Paid" },
    });
  });
});
