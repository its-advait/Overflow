import type { Address } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import { createBehaviourStore, SellerBehaviourSchema, UnknownRecourseSellerError } from "./behaviour.js";
import { SIMULATED_SELLER_LABEL } from "./seller-sim.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const C = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;

describe("behaviour store (SIMULATED sellers)", () => {
  it("defaults by key position: honest, ghost, swap, with the matching SIMULATED label", () => {
    const store = createBehaviourStore([A, B, C]);
    expect(store.list()).toEqual([
      { index: 0, address: A, behaviour: "honest", label: SIMULATED_SELLER_LABEL.honest },
      { index: 1, address: B, behaviour: "ghost", label: SIMULATED_SELLER_LABEL.ghost },
      { index: 2, address: C, behaviour: "swap", label: SIMULATED_SELLER_LABEL.swap },
    ]);
  });

  it("set changes only that seller's next behaviour and is read back case-insensitively", () => {
    const store = createBehaviourStore([A, B, C]);
    expect(store.set(A, "ghost")).toMatchObject({ index: 0, behaviour: "ghost", label: SIMULATED_SELLER_LABEL.ghost });
    expect(store.get(A.toUpperCase().replace("0X", "0x"))).toBe("ghost");
    expect(store.get(B)).toBe("ghost");
    expect(store.get(C)).toBe("swap");
    expect(store.indexOf(C)).toBe(2);
  });

  it("refuses an address that is not a SIMULATED seller and a behaviour outside the enum", () => {
    const store = createBehaviourStore([A, B, C]);
    const stranger = "0x1111111111111111111111111111111111111111";
    expect(() => store.get(stranger)).toThrow(UnknownRecourseSellerError);
    expect(() => store.set(stranger, "honest")).toThrow(UnknownRecourseSellerError);
    expect(store.indexOf(stranger)).toBeUndefined();
    expect(SellerBehaviourSchema.safeParse("lazy").success).toBe(false);
    expect(() => store.set(A, "lazy" as never)).toThrow();
    expect(store.get(A)).toBe("honest");
  });
});
