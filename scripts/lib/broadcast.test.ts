import { describe, expect, it } from "vitest";
import { type Broadcast, broadcastTimestamp, initCodeMatcher, readBroadcast } from "./broadcast";

const DEPLOYER = "0xb6f4162192f753c9998b63893cbb48fa046906c3" as const;
const TREASURY = "0x1111111111111111111111111111111111111111" as const;
const FACTORY = "0x2222222222222222222222222222222222222222" as const;
const IMPL = "0x3333333333333333333333333333333333333333" as const;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
/** Stand-in for OverflowEscrow creation code; the real one comes from contracts/out at export time. */
const ESCROW_CODE = "0x60a060405234801561000f575f5ffd5b50604051" as const;
const OTHER_CODE = "0x6080604052348015600e575f5ffd5b50deadbeef" as const;
const ctorArgs = `000000000000000000000000${FACTORY.slice(2)}`;

/** The shape of the treasury-only broadcast on disk today (contracts/broadcast/Deploy.s.sol/84532/run-latest.json). */
const treasuryOnly: Broadcast = {
  transactions: [
    { hash: h(1), transactionType: "CREATE", contractName: "OverflowTreasury", contractAddress: TREASURY, function: null, transaction: { from: DEPLOYER }, additionalContracts: [] },
    { hash: h(2), transactionType: "CALL", contractName: "OverflowTreasury", contractAddress: TREASURY, function: "createRoot(address,uint256,uint256,uint256)", transaction: { from: DEPLOYER, to: TREASURY }, additionalContracts: [] },
  ],
  receipts: [
    { blockNumber: "0x2f8a3ce", transactionHash: h(1) },
    { blockNumber: "0x2f8a3d0", transactionHash: h(2) },
  ],
  timestamp: 1792891768225,
};

/** The full Deploy.s.sol: the factory's constructor creates the escrow implementation (a nested create). */
const withFactory: Broadcast = {
  transactions: [
    treasuryOnly.transactions[0] as Broadcast["transactions"][number],
    {
      hash: h(3),
      transactionType: "CREATE",
      contractName: "OverflowEscrowFactory",
      contractAddress: FACTORY,
      function: null,
      transaction: { from: DEPLOYER },
      additionalContracts: [{ transactionType: "CREATE", address: IMPL, initCode: `${ESCROW_CODE}${ctorArgs}` }],
    },
    { hash: h(4), transactionType: "CALL", contractName: "OverflowTreasury", contractAddress: TREASURY, function: "setEscrowFactory(address)", transaction: { from: DEPLOYER, to: TREASURY }, additionalContracts: [] },
    { hash: h(5), transactionType: "CALL", contractName: "OverflowTreasury", contractAddress: TREASURY, function: "setAllow(address,bool)", transaction: { from: DEPLOYER, to: TREASURY }, additionalContracts: [] },
    { hash: h(6), transactionType: "CALL", contractName: "OverflowTreasury", contractAddress: TREASURY, function: "createRoot(address,uint256,uint256,uint256)", transaction: { from: DEPLOYER, to: TREASURY }, additionalContracts: [] },
  ],
  receipts: [3, 4, 5, 6, 7].map((n, i) => ({ blockNumber: 50_000_000 + n, transactionHash: h(i + 1) })),
  timestamp: 1792900000000,
};

describe("readBroadcast", () => {
  const isEscrow = initCodeMatcher(ESCROW_CODE);

  it("treasury-only broadcast: factory and implementation stay null, txs and deployBlock as before", () => {
    const s = readBroadcast(treasuryOnly, { isEscrowInitCode: isEscrow });
    expect(s.treasury).toEqual({ address: TREASURY, hash: h(1), via: "transaction", from: DEPLOYER });
    expect(s.escrowFactory).toBeNull();
    expect(s.escrowImplementation).toBeNull();
    expect(s.txs).toEqual({ treasury: h(1), createRoot: h(2) });
    expect(s.deployBlock).toBe(0x2f8a3cen);
    expect(s.notes).toEqual([]);
    expect(broadcastTimestamp(treasuryOnly).toISOString()).toBe("2026-10-25T01:29:28.225Z");
  });

  it("finds the escrow implementation in the factory tx's additionalContracts by init code", () => {
    const s = readBroadcast(withFactory, { isEscrowInitCode: isEscrow });
    expect(s.escrowFactory).toEqual({ address: FACTORY, hash: h(3), via: "transaction" });
    expect(s.escrowImplementation).toEqual({ address: IMPL, hash: h(3), via: "nested" });
    expect(s.txs).toEqual({ treasury: h(1), escrowFactory: h(3), escrowImplementation: h(3), setEscrowFactory: h(4), setAllow: h(5), createRoot: h(6) });
    expect(s.deployBlock).toBe(50_000_003n);
    expect(s.notes.join("\n")).toMatch(/nested create of tx/);
  });

  it("leaves the implementation null and says how to read it when no nested init code matches", () => {
    const s = readBroadcast(withFactory, { isEscrowInitCode: initCodeMatcher(OTHER_CODE) });
    expect(s.escrowFactory?.address).toBe(FACTORY);
    expect(s.escrowImplementation).toBeNull();
    expect(s.txs["escrowImplementation"]).toBeUndefined();
    expect(s.notes.join("\n")).toContain(`cast call ${FACTORY} "implementation()(address)"`);
  });

  it("refuses to guess between several matching nested creates", () => {
    const factoryTx = withFactory.transactions[1] as Broadcast["transactions"][number];
    const twin: Broadcast = {
      ...withFactory,
      transactions: [
        withFactory.transactions[0] as Broadcast["transactions"][number],
        { ...factoryTx, additionalContracts: [...(factoryTx.additionalContracts ?? []), { transactionType: "CREATE", address: "0x4444444444444444444444444444444444444444", initCode: ESCROW_CODE }] },
      ],
    };
    const s = readBroadcast(twin, { isEscrowInitCode: isEscrow });
    expect(s.escrowImplementation).toBeNull();
    expect(s.notes.join("\n")).toMatch(/2 nested creates match/);
  });

  it("prefers a top-level OverflowEscrow CREATE when the script deploys it directly", () => {
    const direct: Broadcast = {
      ...treasuryOnly,
      transactions: [
        ...treasuryOnly.transactions,
        { hash: h(9), transactionType: "CREATE", contractName: "OverflowEscrow", contractAddress: IMPL, function: null, transaction: { from: DEPLOYER }, additionalContracts: [] },
      ],
    };
    expect(readBroadcast(direct, { isEscrowInitCode: isEscrow }).escrowImplementation).toEqual({ address: IMPL, hash: h(9), via: "transaction" });
  });

  it("rejects a broadcast without a treasury or without receipts", () => {
    expect(() => readBroadcast({ ...treasuryOnly, transactions: [] }, { isEscrowInitCode: isEscrow })).toThrow(/no OverflowTreasury/);
    expect(() => readBroadcast({ ...treasuryOnly, receipts: [] }, { isEscrowInitCode: isEscrow })).toThrow(/no receipts/);
  });

  it("initCodeMatcher is case-insensitive and needs non-empty hex", () => {
    expect(initCodeMatcher(ESCROW_CODE)(`${ESCROW_CODE.toUpperCase().replace("0X", "0x")}00` as `0x${string}`)).toBe(true);
    expect(initCodeMatcher(ESCROW_CODE)(OTHER_CODE)).toBe(false);
    expect(() => initCodeMatcher("0x" as `0x${string}`)).toThrow();
  });
});
