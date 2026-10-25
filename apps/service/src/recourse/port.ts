import type { Address, RecourseSellerView, SellerBehaviour } from "@overflow/schemas";
import type { RecoursePort } from "../api/ports.js";
import { makeMutex } from "../facilitator/relayer.js";
import { createBehaviourStore, UnknownRecourseSellerError } from "./behaviour.js";
import { claimTimeouts, createRunContext, runOrder, runRecourseOnAnvil, type OrderOutcome, type RecourseRunDeps, type RecourseRunResult, type RunContext } from "./run.js";

// ---------------------------------------------------------------------------
// The judge's handle on the SIMULATED recourse run (docs/SPEC.md "A judge's own
// scenario"): which behaviour each seller plays next, and "run one order now".
// One mutex serialises every order, the boot demo included: they share the one
// relayer and the one Anvil clock, and a ghost order warps that clock. Nothing
// here moves money or sets a status; the contracts and the indexer do.
// ---------------------------------------------------------------------------

export class RecourseOrderError extends Error {
  constructor(
    message: string,
    public readonly listingId: string,
    public readonly sellerAddress: Address,
  ) {
    super(message);
    this.name = "RecourseOrderError";
  }
}

export interface RecourseRunner extends RecoursePort {
  /** The boot demo (BOOT_ORDERS), queued behind any order a judge started. */
  demo(): Promise<RecourseRunResult>;
}

export function createRecoursePort(deps: RecourseRunDeps): RecourseRunner {
  const lock = makeMutex();
  const accounts = deps.accounts.sellerList;
  const store = createBehaviourStore(accounts.map((a) => a.address));
  let ctx: Promise<RunContext> | undefined;
  const context = (): Promise<RunContext> => (ctx ??= createRunContext(deps));

  const accountFor = (address: Address) => {
    const index = store.indexOf(address);
    if (index === undefined) throw new UnknownRecourseSellerError(address);
    return accounts[index]!;
  };

  const sellers = async (): Promise<RecourseSellerView[]> => {
    const c = await context();
    const out: RecourseSellerView[] = [];
    for (const s of store.list()) {
      const history = await c.repos.sellerHistory.get(s.address);
      out.push({ ...s, flagged: history?.flagged ?? false, simulated: true });
    }
    return out;
  };

  return {
    sellers,
    async setBehaviour(address: Address, behaviour: SellerBehaviour): Promise<RecourseSellerView> {
      const c = await context();
      const s = store.set(address, behaviour);
      deps.log(`[recourse:SIMULATED] seller ${s.index} ${s.address} will play ${behaviour} on its next order (judge control)`);
      const history = await c.repos.sellerHistory.get(s.address);
      return { ...s, flagged: history?.flagged ?? false, simulated: true };
    },
    runOrder: (input) =>
      lock(async (): Promise<OrderOutcome> => {
        const account = accountFor(input.sellerAddress);
        const behaviour = store.get(input.sellerAddress);
        const c = await context();
        try {
          const live = await runOrder(c, { behaviour, account, listingId: input.listingId, ...(input.bondAtomic !== undefined ? { bondAtomic: input.bondAtomic } : {}) });
          await claimTimeouts(c, [live]);
          return live.outcome;
        } catch (e) {
          if (e instanceof UnknownRecourseSellerError) throw e;
          if (e instanceof Error && e.name === "ActivePurchaseExistsError") throw e;
          throw new RecourseOrderError(e instanceof Error ? e.message : String(e), input.listingId, input.sellerAddress);
        }
      }),
    demo: () => lock(async () => runRecourseOnAnvil(deps, await context())),
  };
}
