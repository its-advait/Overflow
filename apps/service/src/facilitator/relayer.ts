import type { Address, Hex, TransactionReceipt } from "viem";
import type { ChainClient } from "../chain/client";

/**
 * One in-flight transaction per relayer key: nonce fetch, broadcast and receipt all run under a single promise
 * chain, so a second request waits for the first receipt. The local nonce is re-synced from the node after any
 * send failure. A receipt timeout returns `status: "unknown"` with the hash; callers never retry with a new nonce.
 * The key signs inside the ChainClient; this module never sees or logs it.
 */
export type SubmitRequest = { to: Address; data: Hex; gas?: bigint; label: string };
export type SubmitResult =
  | { status: "success"; hash: Hex; receipt: TransactionReceipt }
  | { status: "reverted"; hash: Hex; receipt: TransactionReceipt }
  | { status: "unknown"; hash: Hex; error: string };

export type Relayer = {
  address: Address;
  submit(req: SubmitRequest): Promise<SubmitResult>;
  pending(): number;
  queued(): number;
};

export function makeMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createRelayer(opts: {
  client: ChainClient;
  address: Address;
  receiptTimeoutMs?: number;
  log?: (line: string) => void;
}): Relayer {
  const { client, address } = opts;
  const timeout = opts.receiptTimeoutMs ?? 90_000;
  const log = opts.log ?? (() => {});
  const lock = makeMutex();
  let nextNonce: number | undefined;
  let inFlight = 0;
  let waiting = 0;

  async function nonce(): Promise<number> {
    if (nextNonce === undefined) nextNonce = await client.getTransactionCount(address, "pending");
    return nextNonce;
  }

  return {
    address,
    pending: () => inFlight,
    queued: () => waiting,
    submit(req) {
      waiting++;
      return lock(async () => {
        waiting--;
        inFlight++;
        try {
          const n = await nonce();
          let hash: Hex;
          try {
            hash = await client.sendTransaction({
              to: req.to,
              data: req.data,
              nonce: n,
              ...(req.gas !== undefined ? { gas: req.gas } : {}),
            });
          } catch (e) {
            nextNonce = undefined; // re-sync from the node next time
            throw e;
          }
          nextNonce = n + 1;
          log(`[relayer] ${req.label} sent ${hash} nonce ${n}`);
          try {
            const receipt = await client.waitForTransactionReceipt({ hash, timeoutMs: timeout });
            return receipt.status === "success"
              ? { status: "success", hash, receipt }
              : { status: "reverted", hash, receipt };
          } catch (e) {
            nextNonce = undefined;
            return { status: "unknown", hash, error: e instanceof Error ? e.message : String(e) };
          }
        } finally {
          inFlight--;
        }
      });
    },
  };
}
