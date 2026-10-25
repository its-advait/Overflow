import { USDC, type MissionRecord, type ResourceRecord } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import { b32, ESCROW, NOW, SELLER, TREASURY } from "../test-db.js";
import type { OrderTermsInput } from "./oracle-port.js";
import { fakeEscrowAddress, fakeRecourseSeller, type FakeSellerOptions } from "./seller-order-terms.test-util.js";
import { createSellerOrderTerms, SellerTermsError } from "./seller-order-terms.js";

const now = () => new Date(NOW);
const mission = { id: "mission-1", organizationId: "org-demo" } as MissionRecord;
const resource = { id: "resource-1", priceAtomic: "12000000", manifestHash: b32(5), simulated: true } as ResourceRecord;
const input: OrderTermsInput = { mission, resource, amountAtomic: "12000000", buyerTreasury: TREASURY, requestIds: ["req-1"] };
const listing = () => ({ priceAtomic: resource.priceAtomic, manifestHash: resource.manifestHash });

function portWith(over: Partial<FakeSellerOptions> = {}, readsOver: Partial<ReturnType<typeof fakeRecourseSeller>["reads"]> = {}) {
  const seller = fakeRecourseSeller({ listing, now, ...over });
  const port = createSellerOrderTerms({ sellerUrl: "http://seller.test/", fetch: seller.fetch, reads: { ...seller.reads, ...readsOver }, treasury: TREASURY, now });
  return { seller, port };
}

const rejects = async (p: Promise<unknown>, reason: RegExp) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SellerTermsError);
  expect((err as SellerTermsError).reason).toMatch(reason);
};

describe("createSellerOrderTerms (buyer side of the SIMULATED Recourse seller)", () => {
  it("happy path: POSTs the order, recomputes both hashes, checks the factory and returns the escrow row terms", async () => {
    const { seller, port } = portWith();
    const terms = await port.prepare(input);
    expect(seller.calls).toEqual([{ resourceId: "resource-1", buyerTreasury: TREASURY, missionId: "mission-1" }]);
    expect(terms.sellerAddress).toBe(SELLER);
    expect(terms.escrowAddress).toBe(fakeEscrowAddress(terms.orderIdBytes32, terms.termsHash));
    expect(seller.created.has(terms.escrowAddress.toLowerCase())).toBe(true);
    expect(terms.simulated).toBe(true);
    // min(revealDeadline = now + 600 s, now + QUOTE_TIMEOUT_SECONDS = 120 s)
    expect(terms.authorizationExpiresAt).toBe("2026-10-24T16:02:00.000Z");
    expect(terms.escrow).toMatchObject({
      orderIdBytes32: terms.orderIdBytes32,
      escrowAddress: terms.escrowAddress,
      sellerAddress: SELLER,
      amountAtomic: "12000000",
      bondAtomic: "2400000",
      termsHash: terms.termsHash,
      manifestHash: b32(5),
      rootPlain: b32(0xa1),
      rootCipher: b32(0xa2),
      keyCommitment: b32(0xa3),
      revealDeadline: String(Math.floor(new Date(NOW).getTime() / 1000) + 600),
      challengeWindow: "300",
      minTimestamp: "1609459200",
    });
    expect(Object.keys(terms.escrow!)).not.toContain("purchaseId");
  });

  it("wrong termsHash on the wire: rejected", async () => {
    const { port } = portWith({ mutate: (r) => ({ ...r, terms: { ...r.terms, termsHash: b32(9) } }) });
    await rejects(port.prepare(input), /termsHash/);
  });

  it("wrong orderId: rejected", async () => {
    const { port } = portWith({ mutate: (r) => ({ ...r, orderId: b32(8), terms: { ...r.terms, orderId: b32(8) } }) });
    await rejects(port.prepare(input), /orderId/);
  });

  it("buyer is not the treasury: rejected before any chain read", async () => {
    const { port } = portWith({ mutate: (r) => ({ ...r, terms: { ...r.terms, buyer: ESCROW } }) });
    await rejects(port.prepare(input), /buyer/);
  });

  it("amount differs from the listed price: rejected", async () => {
    const { port } = portWith({ listing: () => ({ priceAtomic: "12000001", manifestHash: b32(5) }) });
    await rejects(port.prepare(input), /amount/);
  });

  it("manifestHash differs from the listing: rejected", async () => {
    const { port } = portWith({ listing: () => ({ priceAtomic: "12000000", manifestHash: b32(6) }) });
    await rejects(port.prepare(input), /manifestHash/);
  });

  it("token is not USDC: rejected", async () => {
    const { port } = portWith({ mutate: (r) => ({ ...r, terms: { ...r.terms, token: ESCROW } }) });
    await rejects(port.prepare(input), /USDC/);
    expect(USDC.address).not.toBe(ESCROW);
  });

  it("factory does not know the escrow: rejected", async () => {
    const { port } = portWith({}, { isEscrow: async () => false });
    await rejects(port.prepare(input), /does not know this escrow/);
  });

  it("predict disagrees with the escrow address: rejected", async () => {
    const { port } = portWith({}, { predict: async () => ESCROW });
    await rejects(port.prepare(input), /predict/);
  });

  it("seller 500: rejected with the status, no terms invented", async () => {
    const { port } = portWith({ status: 500 });
    const err = await port.prepare(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SellerTermsError);
    expect((err as SellerTermsError).reason).toBe("seller answered 500");
    expect((err as SellerTermsError).details).toMatchObject({ status: 500 });
  });

  it("input treasury differing from the deployed one: rejected without calling the seller", async () => {
    const { seller, port } = portWith();
    await rejects(port.prepare({ ...input, buyerTreasury: ESCROW }), /treasury/);
    expect(seller.calls).toEqual([]);
  });
});
