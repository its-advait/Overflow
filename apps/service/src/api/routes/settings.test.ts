import type { Address, RecourseSellerView } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnknownRecourseSellerError } from "../../recourse/behaviour.js";
import type { OrderOutcome } from "../../recourse/run.js";
import { b32, ESCROW, SELLER, testDatabase } from "../../test-db.js";
import { createApp } from "../app.js";
import type { RecourseOrderInput, RecoursePort } from "../ports.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;
const JSON_HEADERS = { "content-type": "application/json" };
const OTHER = "0x5555555555555555555555555555555555555555" as Address;

/** SIMULATED port: an in-memory behaviour map and a recorded runOrder; no chain, no runner. */
function fakePort() {
  const behaviours = new Map<string, RecourseSellerView["behaviour"]>([[SELLER.toLowerCase(), "honest"]]);
  const runs: RecourseOrderInput[] = [];
  const view = (address: Address): RecourseSellerView => ({ index: 0, address, behaviour: behaviours.get(address.toLowerCase())!, label: "SIMULATED seller", flagged: false, simulated: true });
  const known = (address: Address) => {
    if (!behaviours.has(address.toLowerCase())) throw new UnknownRecourseSellerError(address);
  };
  const port: RecoursePort = {
    sellers: async () => [view(SELLER)],
    setBehaviour: async (address, behaviour) => {
      known(address);
      behaviours.set(address.toLowerCase(), behaviour);
      return view(address);
    },
    runOrder: async (input) => {
      known(input.sellerAddress);
      runs.push(input);
      const outcome: OrderOutcome = {
        behaviour: behaviours.get(input.sellerAddress.toLowerCase())!,
        listingId: input.listingId,
        purchaseId: "pur-judge-1",
        escrow: ESCROW,
        orderId: b32(7),
        seller: input.sellerAddress,
        amountAtomic: "6000000",
        bondAtomic: (input.bondAtomic ?? 1_200_000n).toString(),
        sampleVerdict: "buy",
        lastStep: "awaiting timeout",
        txs: { create: b32(0xc1), bond: b32(0xb0), settle: b32(0x5e), markFunded: b32(0xf1) },
      };
      return outcome;
    },
  };
  return { port, runs };
}

describe("/api/settings (judge controls)", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  const session = { organizationId: "org-demo", principal: "owner" as const, ownerAddress: null };
  beforeAll(async () => {
    handle = await testDatabase();
  });
  afterAll(() => handle.close());

  it("answers 501 not_wired on every route when no recourse port or network reader is wired", async () => {
    const { app } = createApp({ db: handle.db, session });
    for (const [method, path] of [
      ["GET", "/api/settings/sellers"],
      ["PUT", `/api/settings/sellers/${SELLER}`],
      ["POST", "/api/settings/orders"],
      ["GET", "/api/settings/network"],
    ] as const) {
      const body = method === "PUT" ? { behaviour: "ghost" } : method === "POST" ? { sellerAddress: SELLER, listingId: "resource-1" } : undefined;
      const res = await app.request(path, { method, headers: JSON_HEADERS, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(res.status, `${method} ${path}`).toBe(501);
      expect((await json(res)).error.code).toBe("not_wired");
    }
  });

  it("lists sellers, changes one seller's next behaviour and refuses bad input", async () => {
    const { port } = fakePort();
    const { app } = createApp({ db: handle.db, session, ports: { recourse: port } });
    const list = await app.request("/api/settings/sellers");
    expect(list.status).toBe(200);
    const body = await json(list);
    expect(body.simulated).toBe(true);
    expect(body.note).toMatch(/SIMULATED/);
    expect(body.sellers).toEqual([{ index: 0, address: SELLER, behaviour: "honest", label: "SIMULATED seller", flagged: false, simulated: true }]);

    const put = await app.request(`/api/settings/sellers/${SELLER}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ behaviour: "ghost" }) });
    expect(put.status).toBe(200);
    expect((await json(put)).seller.behaviour).toBe("ghost");
    expect(await port.sellers()).toMatchObject([{ behaviour: "ghost" }]);

    const bad = await app.request(`/api/settings/sellers/${SELLER}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ behaviour: "lazy" }) });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.code).toBe("validation_error");

    const unknown = await app.request(`/api/settings/sellers/${OTHER}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ behaviour: "swap" }) });
    expect(unknown.status).toBe(404);
    expect((await json(unknown)).error).toMatchObject({ code: "unknown_seller", details: { address: OTHER } });

    const notAddress = await app.request("/api/settings/sellers/not-an-address", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ behaviour: "swap" }) });
    expect(notAddress.status).toBe(400);
  });

  it("runs one order through the port and answers the runner's outcome, labelled SIMULATED, with the indexer note", async () => {
    const { port, runs } = fakePort();
    const { app } = createApp({ db: handle.db, session, ports: { recourse: port } });
    const res = await app.request("/api/settings/orders", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sellerAddress: SELLER, listingId: "listing-national-annual-2024-2026", bondAtomic: "1500000" }) });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.simulated).toBe(true);
    expect(body.note).toMatch(/GET \/api\/escrow\/:purchaseId/);
    expect(body.order).toMatchObject({ behaviour: "honest", listingId: "listing-national-annual-2024-2026", purchaseId: "pur-judge-1", escrow: ESCROW, bondAtomic: "1500000", lastStep: "awaiting timeout" });
    expect(Object.keys(body.order.txs)).toEqual(["create", "bond", "settle", "markFunded"]);
    expect(runs).toEqual([{ sellerAddress: SELLER, listingId: "listing-national-annual-2024-2026", bondAtomic: 1_500_000n }]);

    const bad = await app.request("/api/settings/orders", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sellerAddress: "0x12", listingId: "x" }) });
    expect(bad.status).toBe(400);
    const unknown = await app.request("/api/settings/orders", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sellerAddress: OTHER, listingId: "x" }) });
    expect(unknown.status).toBe(404);
    expect(runs).toHaveLength(1);
  });

  it("GET /network answers the network reader's snapshot", async () => {
    const info = {
      chainId: 84532,
      network: "local Anvil fork" as const,
      rpc: "http://127.0.0.1:8545",
      treasury: "0x1111111111111111111111111111111111111111" as Address,
      escrowFactory: null,
      owner: OTHER,
      floorAtomic: "0",
      reservationWindowSeconds: "600",
      reservedTotalAtomic: "0",
      nodeCount: "1",
      token: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address, name: "USDC", version: "2", decimals: 6, domainSeparator: b32(0x71) },
      relayer: "0x2222222222222222222222222222222222222222" as Address,
      blockNumber: "49900000",
      readAt: "2026-10-25T12:00:00.000Z",
    };
    const { app } = createApp({ db: handle.db, session, ports: { network: { read: async () => info } } });
    const res = await app.request("/api/settings/network");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual(info);
  });
});
