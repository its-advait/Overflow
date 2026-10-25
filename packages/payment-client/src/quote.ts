import { getAddress, isAddress, type Address } from "viem";
import { AtomicAmountSchema, PurchaseOrderSchema, USDC, type PurchaseOrder } from "@overflow/schemas";
import { QuoteMismatchError } from "./errors";
import {
  PaymentRequirementsSchema,
  X402_ASSET_TRANSFER_METHOD_EIP3009,
  X402_NETWORK_BASE_SEPOLIA,
  X402_SCHEME_EXACT,
  type PaymentRequired,
  type PaymentRequirements,
} from "./x402";

// ---------------------------------------------------------------------------
// Quote checks (docs/SPEC.md "One payment interface, two paths"):
// "Before signing, the payment client rejects any quote whose payTo, amount, asset or
//  network differs from the purchase order."
// Every mismatch throws QuoteMismatchError naming the x402 field. Nothing is signed after.
// ---------------------------------------------------------------------------

export interface QuoteCheckOptions {
  /**
   * Sellers the treasury owner has allowlisted for direct (non-escrow) payment. A quote may
   * name one of these as payTo only when it is also the order's sellerAddress.
   */
  approvedDirectSellers?: readonly Address[];
}

const CHECKED = Symbol("CheckedQuote");

/** A quote that passed every check. Only this type can be handed to the signing path. */
export interface CheckedQuote {
  readonly [CHECKED]: true;
  readonly requirements: PaymentRequirements;
  readonly order: PurchaseOrder;
  /** Checksummed payee: the order's escrow, or an approved direct seller. */
  readonly payTo: Address;
  readonly payeeKind: "escrow" | "direct-seller";
  /** Atomic USDC units. */
  readonly value: bigint;
  readonly valueAtomic: string;
  readonly token: Address;
  readonly chainId: typeof USDC.chainId;
  /** EIP-712 domain the seller asked us to sign under; equals the pinned USDC domain. */
  readonly domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  readonly maxTimeoutSeconds: number;
}

export function isCheckedQuote(v: unknown): v is CheckedQuote {
  return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[CHECKED] === true;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function expectAddress(field: string, value: string): Address {
  if (!isAddress(value, { strict: false })) {
    throw new QuoteMismatchError(field, "a 20-byte hex address", value);
  }
  return getAddress(value);
}

/**
 * Check a seller's PaymentRequirements against our PurchaseOrder. Check order:
 * scheme, network, asset, payTo, amount, extra.name, extra.version, extra.assetTransferMethod.
 */
export function checkQuote(
  requirementsInput: unknown,
  orderInput: unknown,
  options: QuoteCheckOptions = {},
): CheckedQuote {
  const requirements = PaymentRequirementsSchema.parse(requirementsInput);
  const order = PurchaseOrderSchema.parse(orderInput);

  if (requirements.scheme !== X402_SCHEME_EXACT) {
    throw new QuoteMismatchError("scheme", X402_SCHEME_EXACT, requirements.scheme);
  }

  const expectedNetwork: string = `eip155:${order.chainId}`;
  if (expectedNetwork !== X402_NETWORK_BASE_SEPOLIA) {
    throw new QuoteMismatchError("order.chainId", String(USDC.chainId), String(order.chainId));
  }
  if (requirements.network !== X402_NETWORK_BASE_SEPOLIA) {
    throw new QuoteMismatchError("network", X402_NETWORK_BASE_SEPOLIA, requirements.network);
  }

  if (!same(order.tokenAddress, USDC.address)) {
    throw new QuoteMismatchError("order.tokenAddress", USDC.address, order.tokenAddress);
  }
  const asset = expectAddress("asset", requirements.asset);
  if (!same(asset, USDC.address)) {
    throw new QuoteMismatchError("asset", USDC.address, requirements.asset);
  }

  const payTo = expectAddress("payTo", requirements.payTo);
  let payeeKind: CheckedQuote["payeeKind"];
  if (same(payTo, order.escrowAddress)) {
    payeeKind = "escrow";
  } else {
    const approved = (options.approvedDirectSellers ?? []).some((a) => same(a, payTo));
    if (approved && same(payTo, order.sellerAddress)) {
      payeeKind = "direct-seller";
    } else {
      throw new QuoteMismatchError(
        "payTo",
        approved
          ? `${order.escrowAddress} (order escrow) or ${order.sellerAddress} (order seller)`
          : `${order.escrowAddress} (order escrow) or an approved direct seller`,
        requirements.payTo,
      );
    }
  }

  if (!AtomicAmountSchema.safeParse(requirements.amount).success) {
    throw new QuoteMismatchError("amount", `${order.amountAtomic} (decimal atomic units)`, requirements.amount);
  }
  const value = BigInt(requirements.amount);
  if (value !== BigInt(order.amountAtomic)) {
    throw new QuoteMismatchError("amount", order.amountAtomic, requirements.amount);
  }

  const extra = requirements.extra ?? {};
  if (extra.name !== USDC.name) {
    throw new QuoteMismatchError("extra.name", USDC.name, String(extra.name));
  }
  if (extra.version !== USDC.version) {
    throw new QuoteMismatchError("extra.version", USDC.version, String(extra.version));
  }
  if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== X402_ASSET_TRANSFER_METHOD_EIP3009) {
    throw new QuoteMismatchError(
      "extra.assetTransferMethod",
      X402_ASSET_TRANSFER_METHOD_EIP3009,
      String(extra.assetTransferMethod),
    );
  }

  return {
    [CHECKED]: true,
    requirements,
    order,
    payTo,
    payeeKind,
    value,
    valueAtomic: value.toString(),
    token: USDC.address,
    chainId: USDC.chainId,
    domain: {
      name: USDC.name,
      version: USDC.version,
      chainId: USDC.chainId,
      verifyingContract: USDC.address,
    },
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
  };
}

/**
 * Pick the `accepts[]` entry we can pay: scheme "exact" on Base Sepolia. Returns null when the
 * seller offers nothing we support (the caller then leaves the 402 unpaid).
 */
export function selectRequirements(paymentRequired: PaymentRequired): PaymentRequirements | null {
  return (
    paymentRequired.accepts.find(
      (a) => a.scheme === X402_SCHEME_EXACT && a.network === X402_NETWORK_BASE_SEPOLIA,
    ) ?? null
  );
}
