/**
 * End-to-end purchase flow against a running service (pnpm --filter @overflow/service dev), driven through the
 * HTTP API only. Nothing here signs or sends; every status this script prints came back from the API, and every
 * terminal status the API shows was set by the indexer from a confirmed Base Sepolia event.
 *
 *   pnpm --filter @overflow/service flow:demo -- [--beat honest|ghost|swap|all] [--resource <listingId>] [--timeout 900]
 *
 * Beats (both SIMULATED Recourse sellers are switched to the beat's behavior, and back to honest at the end):
 *   honest  seller delivers; expected SETTLED with a data-expense ledger entry
 *   ghost   seller never reveals; expected REFUNDED (timeout) after the reveal window (RECOURSE_REVEAL_WINDOW_S)
 *   swap    seller tampers one chunk; expected REFUNDED (mismatch) proven on chain, GET /api/escrow shows the refund
 * Every beat also requires GET /api/reconciliation to show no open exception and no material difference.
 * Exit code 0 only when every selected beat passes.
 *
 * Env (repo .env): SERVICE_URL (default http://localhost:4000), SELLER_URL (default http://localhost:4100).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  explorerUrl,
  TERMINAL_STATUSES,
  type ActivityEvent,
  type ChainTransaction,
  type EscrowOrder,
  type ExceptionRecord,
  type FinancialEntry,
  type PurchaseRecord,
  type ReconciliationRun,
  type ResourceRecord,
} from "@overflow/schemas";

const envFile = resolve(process.cwd(), "../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const SERVICE = (process.env["SERVICE_URL"] ?? "http://localhost:4000").replace(/\/$/, "");
const SELLER = (process.env["SELLER_URL"] ?? "http://localhost:4100").replace(/\/$/, "");
const timeoutMs = Number(opt("timeout", "900")) * 1000;
const POLL_MS = 3000;
/** 20 USDC in atomic units (6 decimals). Integer string, never a float. */
const BUDGET_ATOMIC = "20000000";

type Beat = "honest" | "ghost" | "swap";
type Behavior = "honest" | "ghost" | "swap";
const BEATS: readonly Beat[] = ["honest", "ghost", "swap"];
/** The two SIMULATED Recourse sellers (data/catalog.json). */
const SELLERS = ["sim-seller-a", "sim-seller-b"] as const;
/** Default listing per beat: honest and ghost buy seller A's cheap 2021-2022 set; swap targets seller B so the on-chain cheat flag lands on B. */
const DEFAULT_RESOURCE: Record<Beat, string> = {
  honest: "listing-national-monthly-2021-2022",
  ghost: "listing-national-monthly-2021-2022",
  swap: "listing-national-monthly-2024-2026-seller-b",
};

const beatArg = opt("beat", "all");
if (beatArg !== "all" && !BEATS.includes(beatArg as Beat)) {
  console.error(`[flow-demo] --beat must be one of ${[...BEATS, "all"].join("|")}, got ${beatArg}`);
  process.exit(2);
}
const selectedBeats: Beat[] = beatArg === "all" ? [...BEATS] : [beatArg as Beat];
const resourceOverride = opt("resource", "");

// ---------------------------------------------------------------------------
// HTTP helpers. The API's JSON errors are { error, message, details? }.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
type Reply = { status: number; json: Json };

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}
const api = {
  get: (path: string) => call(SERVICE, "GET", path),
  post: (path: string, body: unknown, headers?: Record<string, string>) => call(SERVICE, "POST", path, body, headers),
};
const describe = (r: Reply) => `${r.status} ${typeof r.json["error"] === "string" ? `${r.json["error"]}: ` : ""}${typeof r.json["message"] === "string" ? r.json["message"] : JSON.stringify(r.json).slice(0, 300)}`;

class BeatFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeatFailure";
  }
}
const expect = (r: Reply, status: number, what: string): Json => {
  if (r.status !== status) throw new BeatFailure(`${what} answered ${describe(r)} (expected ${status})`);
  return r.json;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const txLink = (hash: string | undefined) => (hash ? `  ${explorerUrl("tx", hash)}` : "");

// ---------------------------------------------------------------------------
// Seller behavior (SIMULATED sellers served by the service on SELLER_URL)
// ---------------------------------------------------------------------------

async function setBehaviors(behavior: Behavior): Promise<void> {
  for (const id of SELLERS) {
    const r = await call(SELLER, "PUT", `/sellers/${id}/behavior`, { behavior });
    if (r.status !== 200) throw new Error(`PUT ${SELLER}/sellers/${id}/behavior answered ${describe(r)}`);
    console.log(`[sellers] [SIMULATED] ${id} (${String(r.json["sellerAddress"])}) behavior -> ${String(r.json["behavior"])}`);
  }
}

// ---------------------------------------------------------------------------
// One beat: steps 1 to 3 through the API, authorize (steps 4 to 7), then watch the chain-driven states.
// ---------------------------------------------------------------------------

type PurchaseDetail = { purchase: PurchaseRecord; escrow: EscrowOrder | null; chainTransactions: ChainTransaction[]; activity: ActivityEvent[] };

async function findResource(id: string): Promise<ResourceRecord> {
  const body = expect(await api.get("/api/resources"), 200, "GET /api/resources");
  const resources = body["resources"] as ResourceRecord[];
  const found = resources.find((r) => r.id === id);
  if (!found) throw new BeatFailure(`listing ${id} is not in GET /api/resources (known: ${resources.map((r) => r.id).join(", ")})`);
  return found;
}

/** A goal that names the listing's coverage so the Oracle's coverage filter and price ranking land on it. */
function goalFor(resource: ResourceRecord): string {
  const c = resource.coverage;
  return (
    `Research the US EV registrations market for a product launch: buy the dataset that covers ${c.granularity} ` +
    `EV registrations for ${c.regions.join(", ")} from ${c.dateRange.start} to ${c.dateRange.end} with the fields ` +
    `${c.fields.join(", ")} as ${c.format}, licensed for company use, within budget.`
  );
}

function printEvents(events: ActivityEvent[], seen: Set<string>): void {
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    console.log(
      `  ${ev.at} ${ev.kind.padEnd(26)} ${ev.simulated ? "[SIMULATED] " : ""}${ev.message.slice(0, 240)}` +
        `${ev.decodedRevert ? `  revert ${ev.decodedRevert}` : ""}${txLink(ev.txHash)}`,
    );
  }
}

async function pollUntilTerminal(purchaseId: string, seen: Set<string>, deadline: number): Promise<PurchaseDetail> {
  let last: PurchaseDetail | undefined;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const detail = expect(await api.get(`/api/purchases/${purchaseId}`), 200, `GET /api/purchases/${purchaseId}`) as unknown as PurchaseDetail;
    last = detail;
    printEvents(detail.activity, seen);
    if (detail.purchase.status !== lastStatus) {
      lastStatus = detail.purchase.status;
      console.log(`  [purchase] ${purchaseId} status ${lastStatus}${detail.escrow ? ` (escrow ${detail.escrow.status})` : ""}`);
    }
    if (TERMINAL_STATUSES.includes(detail.purchase.status)) return detail;
    await sleep(POLL_MS);
  }
  if (!last) throw new BeatFailure("never read the purchase");
  throw new BeatFailure(`timed out after ${timeoutMs / 1000}s; purchase ${purchaseId} is ${last.purchase.status}${last.escrow ? ` (escrow ${last.escrow.status})` : ""}`);
}

/** "timeout" | "mismatch" | "promise" from the escrow row, falling back to the indexer's REFUNDED activity message. */
function refundReason(detail: PurchaseDetail): string {
  if (detail.escrow?.refundReason) return detail.escrow.refundReason;
  const ev = [...detail.activity].reverse().find((e) => /Refunded \(/.test(e.message));
  return ev?.message.match(/Refunded \(([^)]+)\)/)?.[1] ?? "";
}

type Reconciliation = { lastRun: ReconciliationRun | null; openExceptions: ExceptionRecord[]; note?: string };

/** Ask for a fresh run when the reconciler is wired (501 otherwise), then read the last run and open exceptions. */
async function readReconciliation(): Promise<Reconciliation> {
  const run = await api.post("/api/reconciliation/run", {});
  if (run.status !== 200) console.log(`  [reconciliation] POST /api/reconciliation/run answered ${describe(run)}; reading the last recorded run`);
  return expect(await api.get("/api/reconciliation"), 200, "GET /api/reconciliation") as unknown as Reconciliation;
}

type Check = { name: string; ok: boolean; detail: string };

async function runBeat(beat: Beat): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const started = Date.now();
  const deadline = started + timeoutMs;
  const listingId = resourceOverride || DEFAULT_RESOURCE[beat];

  console.log(`\n==================== beat: ${beat} ====================`);
  console.log(`Both sellers are SIMULATED (data/catalog.json); behavior for this beat: ${beat}. Target listing: ${listingId}.`);
  await setBehaviors(beat);

  // Steps 1 to 3: mission, Oracle extraction, owner confirmation, Oracle + Fusion proposal with the seller's verified order.
  const resource = await findResource(listingId);
  const created = expect(
    await api.post("/api/missions", { goal: goalFor(resource), budgetAtomic: BUDGET_ATOMIC, horizon: resource.coverage.dateRange, allowedFormats: [resource.coverage.format] }),
    201,
    "POST /api/missions",
  );
  const mission = created["mission"] as { id: string; rootNodeId: number; budgetAtomic: string };
  console.log(`[mission] ${mission.id} root node ${mission.rootNodeId} budget ${mission.budgetAtomic} atomic USDC`);

  const planned = expect(await api.post(`/api/missions/${mission.id}/plan`, {}), 200, "POST /api/missions/:id/plan");
  const requests = planned["requests"] as { id: string; topic: string; regions: string[]; dateRange: { start: string; end: string }; granularity: string; maxPriceAtomic: string }[];
  for (const r of requests) console.log(`[plan] request ${r.id}: ${r.topic} (${r.regions.join(", ")}; ${r.dateRange.start}..${r.dateRange.end}; ${r.granularity}; max ${r.maxPriceAtomic} atomic)`);
  if (requests.length === 0) throw new BeatFailure("the Oracle extracted no requirements");

  expect(await api.post(`/api/missions/${mission.id}/confirm`, {}), 200, "POST /api/missions/:id/confirm");
  console.log(`[confirm] requirements confirmed; nothing bought yet`);

  const proposed = expect(await api.post("/api/purchases/propose", { missionId: mission.id }), 201, "POST /api/purchases/propose");
  const purchases = proposed["purchases"] as PurchaseRecord[];
  const decisions = proposed["decisions"] as { requestId?: string; reason?: string; chosen?: unknown }[];
  for (const d of decisions) console.log(`[oracle] ${JSON.stringify(d).slice(0, 300)}`);
  const purchase = purchases.find((p) => p.status === "PROPOSED") ?? purchases[0];
  if (!purchase) throw new BeatFailure(`propose returned no purchase (${decisions.length} decision(s) above explain why)`);
  console.log(
    `[propose] purchase ${purchase.id} resource ${purchase.resourceId} ${purchase.amountAtomic} atomic USDC, paying node ${purchase.payingNodeId}, ` +
      `seller ${purchase.sellerAddress}, escrow ${purchase.escrowAddress} ${explorerUrl("address", purchase.escrowAddress)}`,
  );
  if (purchase.resourceId !== listingId) {
    console.log(`[propose] note: the Oracle chose ${purchase.resourceId}, not ${listingId}; both sellers run the ${beat} behavior, so the beat proceeds on the chosen listing`);
  }
  if (purchases.length > 1) console.log(`[propose] ${purchases.length} purchases proposed; this beat follows ${purchase.id}`);

  // Steps 4 to 7: sample judgment, quote vs order, sign, submit. One idempotency key per authorization, never reused with another purchase.
  const seen = new Set<string>();
  const idempotencyKey = randomUUID();
  const auth = await api.post(`/api/purchases/${purchase.id}/authorize`, {}, { "Idempotency-Key": idempotencyKey });
  let sampleCaughtSwap = false;
  if (auth.status === 202) {
    const sample = auth.json["sample"] as { id: string; verdict: string; confidence?: number; reason: string } | null;
    if (sample) console.log(`[sample] ${sample.id} verdict ${sample.verdict}${sample.confidence !== undefined ? ` confidence ${sample.confidence}` : ""}: ${sample.reason.slice(0, 240)}`);
    const submission = auth.json["submission"] as { outcome: string; txHash?: string; decodedRevert?: string; error?: string; exceptionId?: string };
    console.log(`[authorize] digest ${String(auth.json["authorizationDigest"] ?? "-")} outcome ${submission.outcome}${txLink(submission.txHash)}${submission.decodedRevert ? ` ${submission.decodedRevert}` : ""}${submission.error ? ` ${submission.error}` : ""}`);
    if (submission.outcome === "held") {
      throw new BeatFailure(`authorization held: low-confidence sample raised exception ${submission.exceptionId}; purchase ${purchase.id} stays PROPOSED until the controller decides it (POST /api/exceptions/${submission.exceptionId}/decide)`);
    }
  } else if (auth.status === 409 && auth.json["error"] === "sample_mismatch" && beat === "swap") {
    // The random sample hit the tampered chunk (p = SAMPLE_SIZE / chunkCount): the buyer stopped before signing.
    sampleCaughtSwap = true;
    console.log(`[authorize] ${describe(auth)}`);
    console.log(`[authorize] the sample caught the swap before funding; nothing was signed, so there is no escrow to refund`);
  } else if (auth.status === 409 && auth.json["error"] === "sample_low_confidence") {
    const details = auth.json["details"] as { exceptionId?: string } | undefined;
    throw new BeatFailure(`authorization held by open LOW_CONFIDENCE_SAMPLE exception ${details?.exceptionId ?? "?"}: ${describe(auth)}`);
  } else {
    throw new BeatFailure(`POST /api/purchases/:id/authorize answered ${describe(auth)}`);
  }

  // Steps 8 to 10 happen on chain (seller bond + markFunded, reveal, accept / complaint / timeout, PaidOut / Refunded); the indexer moves the purchase.
  console.log(`[watch] polling GET /api/purchases/${purchase.id} every ${POLL_MS / 1000}s until a terminal status (timeout ${timeoutMs / 1000}s)`);
  const detail = await pollUntilTerminal(purchase.id, seen, deadline);
  const status = detail.purchase.status;
  for (const tx of detail.chainTransactions) console.log(`  [chain] ${tx.eventName.padEnd(20)} block ${tx.blockNumber} ${tx.confirmed ? "confirmed" : "pending"}${txLink(tx.txHash)}`);

  const ledger = expect(await api.get(`/api/ledger?purchaseId=${purchase.id}`), 200, "GET /api/ledger") as unknown as { entries: FinancialEntry[] };
  for (const e of ledger.entries) console.log(`  [ledger] Dr ${e.debitAccount} / Cr ${e.creditAccount} ${e.amountAtomic} atomic${e.department ? ` (${e.department})` : ""} ${e.memo.slice(0, 120)}${txLink(e.txHash)}`);
  const escrowReply = await api.get(`/api/escrow/${purchase.id}`);
  const escrow = escrowReply.status === 200 ? (escrowReply.json as unknown as { escrow: EscrowOrder; chainTransactions: ChainTransaction[] }) : null;
  if (escrow) console.log(`  [escrow] ${escrow.escrow.escrowAddress} status ${escrow.escrow.status}${escrow.escrow.refundReason ? ` refund reason ${escrow.escrow.refundReason}` : ""} ${explorerUrl("address", escrow.escrow.escrowAddress)}`);
  else console.log(`  [escrow] GET /api/escrow/${purchase.id} answered ${describe(escrowReply)}`);

  const reason = refundReason(detail);
  switch (beat) {
    case "honest": {
      check("purchase SETTLED", status === "SETTLED", `status ${status}`);
      const expense = ledger.entries.filter((e) => e.debitAccount === "data-expense");
      check("ledger books data-expense", expense.length > 0, expense.length > 0 ? `${expense.length} row(s): ${expense.map((e) => `${e.amountAtomic} atomic${e.department ? ` ${e.department}` : ""}`).join(", ")}` : "no data-expense debit for this purchase");
      break;
    }
    case "ghost": {
      check("purchase REFUNDED", status === "REFUNDED", `status ${status}`);
      check("refund reason is timeout", /timeout/i.test(reason), `reason "${reason || "none"}"`);
      break;
    }
    case "swap": {
      if (sampleCaughtSwap) {
        check("swap stopped before funding (sample caught the tampered chunk)", status === "FAILED_BEFORE_FUNDING", `status ${status}; no escrow was funded, so no refund is expected`);
        check("no money moved", ledger.entries.length === 0 && detail.chainTransactions.length === 0, `${ledger.entries.length} ledger row(s), ${detail.chainTransactions.length} chain event(s)`);
      } else {
        check("purchase REFUNDED", status === "REFUNDED", `status ${status}`);
        check("refund reason is mismatch", /mismatch/i.test(reason), `reason "${reason || "none"}"`);
        const refundedTx = escrow?.chainTransactions.find((t) => t.eventName === "Refunded");
        check(
          "GET /api/escrow shows the refund",
          escrow?.escrow.status === "Refunded" && !!refundedTx,
          escrow ? `escrow ${escrow.escrow.status}${refundedTx ? `, Refunded event ${explorerUrl("tx", refundedTx.txHash)}` : ", no Refunded event recorded"}` : "no escrow row",
        );
      }
      break;
    }
  }

  const recon = await readReconciliation();
  const material = recon.lastRun?.differences.filter((d) => d.material) ?? [];
  const openForThisBeat = recon.openExceptions;
  console.log(
    `  [reconciliation] last run ${recon.lastRun ? `${recon.lastRun.id} at ${recon.lastRun.ranAt} (${recon.lastRun.trigger}) block ${recon.lastRun.blockNumber} status ${recon.lastRun.status}, treasury chain ${recon.lastRun.treasuryChainAtomic} vs ledger ${recon.lastRun.treasuryLedgerAtomic}, ${recon.lastRun.escrowsChecked} escrow(s), ${recon.lastRun.differences.length} difference(s)` : `none (${recon.note ?? ""})`}; ${openForThisBeat.length} open exception(s)`,
  );
  for (const d of material) console.log(`    difference ${d.kind} ${d.subject}: ${d.reason} (${d.differenceAtomic} atomic)`);
  for (const e of openForThisBeat) console.log(`    open exception ${e.id} ${e.type}: ${e.reason.slice(0, 160)}`);
  check(
    "reconciliation clean",
    openForThisBeat.length === 0 && material.length === 0 && (recon.lastRun === null || recon.lastRun.status === "ok"),
    `${openForThisBeat.length} open exception(s), ${material.length} material difference(s)${recon.lastRun ? `, run status ${recon.lastRun.status}` : ", no run recorded"}`,
  );

  return checks;
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`flow-demo: ${selectedBeats.join(", ")} against ${SERVICE} (sellers at ${SELLER}); timeout ${timeoutMs / 1000}s per beat`);
  console.log(`Every seller, dataset and misbehavior in this run is SIMULATED (data/catalog.json). Money is real Base Sepolia test USDC moved only by the treasury and escrow contracts.`);
  console.log(`Budget per mission: ${BUDGET_ATOMIC} atomic USDC. This script never signs or sends; it only drives the API.`);

  const results: { beat: Beat; checks: Check[]; error?: string }[] = [];
  try {
    for (const beat of selectedBeats) {
      try {
        results.push({ beat, checks: await runBeat(beat) });
      } catch (err) {
        if (err instanceof BeatFailure) {
          console.log(`[${beat}] FAIL: ${err.message}`);
          results.push({ beat, checks: [], error: err.message });
        } else throw err;
      }
    }
  } finally {
    console.log(`\n[sellers] resetting both SIMULATED sellers to honest`);
    await setBehaviors("honest").catch((e: unknown) => console.error(`[sellers] reset failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  console.log("\n=== DONE WHEN ===");
  let allOk = true;
  for (const r of results) {
    const ok = !r.error && r.checks.length > 0 && r.checks.every((c) => c.ok);
    allOk &&= ok;
    console.log(`${ok ? "PASS" : "FAIL"} ${r.beat}${r.error ? `: ${r.error}` : ""}`);
    for (const c of r.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  }
  console.log(allOk ? "\nRESULT: all selected beats passed" : "\nRESULT: NOT all selected beats passed");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(`[flow-demo] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
