/**
 * Pure reader for a forge broadcast file (contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json).
 *
 * Forge lists only the script's own transactions in `transactions[]`. A contract created *inside* another
 * contract's constructor (OverflowEscrowFactory() deploys the OverflowEscrow implementation) never gets its own
 * entry; it appears in the parent CREATE's `additionalContracts[]` as `{ transactionType, address, initCode }`.
 * The implementation is identified by its init code (creation bytecode || abi.encode(factory)) so the export
 * cannot pick up a clone or an unrelated nested create.
 */

export type Hex = `0x${string}`;

export interface AdditionalContract {
  transactionType: "CREATE" | "CREATE2";
  address: Hex;
  initCode: Hex;
}

export interface BroadcastTx {
  hash: Hex | null;
  transactionType: "CREATE" | "CREATE2" | "CALL";
  contractName: string | null;
  contractAddress: Hex | null;
  function: string | null;
  transaction: { from: Hex; to?: Hex | null };
  additionalContracts?: AdditionalContract[] | null;
}

export interface BroadcastReceipt {
  blockNumber: Hex | number;
  transactionHash: Hex;
}

export interface Broadcast {
  transactions: BroadcastTx[];
  receipts: BroadcastReceipt[];
  /** unix ms in forge >= 1.x; older files hold seconds. */
  timestamp: number;
}

export interface CreatedContract {
  address: Hex;
  /** Hash of the transaction that created it: for a nested create, the parent's hash. */
  hash: Hex;
  /** "transaction" for a top-level CREATE, "nested" for one found in a parent's additionalContracts. */
  via: "transaction" | "nested";
}

export interface BroadcastSummary {
  treasury: CreatedContract & { from: Hex };
  escrowFactory: CreatedContract | null;
  escrowImplementation: CreatedContract | null;
  /** Tx hashes keyed by step; the shape the deployments file stores. */
  txs: Record<string, Hex>;
  /** Lowest receipt block: where indexers start. */
  deployBlock: bigint;
  /** Human-readable facts about how the summary was derived (printed by the exporter). */
  notes: string[];
}

export interface ReadBroadcastOptions {
  /** True iff `initCode` is the OverflowEscrow creation code (optionally followed by constructor args). */
  isEscrowInitCode: (initCode: Hex) => boolean;
}

/** `initCode.startsWith(creationCode)`, case-insensitive; the constructor args follow the code. */
export function initCodeMatcher(creationCode: Hex): (initCode: Hex) => boolean {
  const code = creationCode.toLowerCase();
  if (!/^0x[0-9a-f]{2,}$/.test(code)) throw new Error("creation code must be non-empty hex");
  return (initCode) => initCode.toLowerCase().startsWith(code);
}

function blockNumber(b: Hex | number): bigint {
  return typeof b === "number" ? BigInt(b) : BigInt(b);
}

function isCreate(t: BroadcastTx): boolean {
  return t.transactionType === "CREATE" || t.transactionType === "CREATE2";
}

export function readBroadcast(run: Broadcast, opts: ReadBroadcastOptions): BroadcastSummary {
  const notes: string[] = [];
  const creates = run.transactions.filter(isCreate);
  const byName = (name: string) => creates.find((t) => t.contractName === name) ?? null;

  const treasuryTx = byName("OverflowTreasury");
  if (!treasuryTx?.contractAddress || !treasuryTx.hash) throw new Error("broadcast has no OverflowTreasury CREATE transaction");
  const treasury = { address: treasuryTx.contractAddress, hash: treasuryTx.hash, via: "transaction" as const, from: treasuryTx.transaction.from };

  const factoryTx = byName("OverflowEscrowFactory");
  const escrowFactory: CreatedContract | null =
    factoryTx?.contractAddress && factoryTx.hash ? { address: factoryTx.contractAddress, hash: factoryTx.hash, via: "transaction" } : null;

  let escrowImplementation: CreatedContract | null = null;
  const implTx = byName("OverflowEscrow");
  if (implTx?.contractAddress && implTx.hash) {
    escrowImplementation = { address: implTx.contractAddress, hash: implTx.hash, via: "transaction" };
  } else {
    // Nested creates: scan every CREATE's additionalContracts; the implementation is the one with the escrow init code.
    const matches: CreatedContract[] = [];
    for (const parent of creates) {
      if (!parent.hash) continue;
      for (const extra of parent.additionalContracts ?? []) {
        if ((extra.transactionType === "CREATE" || extra.transactionType === "CREATE2") && opts.isEscrowInitCode(extra.initCode)) {
          matches.push({ address: extra.address, hash: parent.hash, via: "nested" });
        }
      }
    }
    if (matches.length === 1) {
      escrowImplementation = matches[0] as CreatedContract;
      notes.push(`escrow implementation ${escrowImplementation.address} found as a nested create of tx ${escrowImplementation.hash}`);
    } else if (matches.length > 1) {
      notes.push(`${matches.length} nested creates match the OverflowEscrow init code; refusing to guess (addresses ${matches.map((m) => m.address).join(", ")})`);
    } else if (escrowFactory) {
      notes.push(
        `no nested create matches the OverflowEscrow init code; escrowImplementation stays null. Read it with: cast call ${escrowFactory.address} "implementation()(address)" --rpc-url $BASE_SEPOLIA_RPC_URL`,
      );
    }
  }

  const createRootTx = run.transactions.find((t) => t.function?.startsWith("createRoot("));
  const setFactoryTx = run.transactions.find((t) => t.function?.startsWith("setEscrowFactory("));
  const setAllowTx = run.transactions.find((t) => t.function?.startsWith("setAllow("));

  const txs: Record<string, Hex> = { treasury: treasury.hash };
  if (escrowFactory) txs["escrowFactory"] = escrowFactory.hash;
  if (escrowImplementation) txs["escrowImplementation"] = escrowImplementation.hash;
  if (setFactoryTx?.hash) txs["setEscrowFactory"] = setFactoryTx.hash;
  if (setAllowTx?.hash) txs["setAllow"] = setAllowTx.hash;
  if (createRootTx?.hash) txs["createRoot"] = createRootTx.hash;

  if (run.receipts.length === 0) throw new Error("broadcast has no receipts (dry run?); export needs a real broadcast");
  const deployBlock = run.receipts.map((r) => blockNumber(r.blockNumber)).reduce((a, b) => (a < b ? a : b));

  return { treasury, escrowFactory, escrowImplementation, txs, deployBlock, notes };
}

/** forge writes ms since 1.x; older files hold seconds. */
export function broadcastTimestamp(run: Broadcast): Date {
  return new Date(run.timestamp > 1e12 ? run.timestamp : run.timestamp * 1000);
}
