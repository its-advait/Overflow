import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { QuoteMismatchError, buildPaymentHeader, buildPaymentPayload, parsePaymentPayload, signTransfer } from "./index";
import { ESCROW, TREASURY, makeRequirements } from "./test-fixtures";

const NOW = 1_800_000_000;

describe("buildPaymentPayload / buildPaymentHeader", () => {
  it("produces the spec's PaymentPayload shape with accepted echoed and from = treasury", async () => {
    const nodeAccount = privateKeyToAccount(generatePrivateKey());
    const accepted = makeRequirements();
    const signed = await signTransfer({ nodeAccount, treasury: TREASURY, to: ESCROW, value: "8400000", ttlSeconds: 60, nowSeconds: NOW });
    const resource = { url: "https://seller.example/data" };
    const payload = buildPaymentPayload({ accepted, resource, signed });
    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(accepted);
    expect(payload.resource?.url).toBe(resource.url);
    expect(payload.payload.signature).toBe(signed.signature);
    expect(payload.payload.authorization).toEqual({
      from: TREASURY,
      to: ESCROW,
      value: "8400000",
      validAfter: String(NOW - 5),
      validBefore: String(NOW + 60),
      nonce: signed.authorization.nonce,
    });

    const header = buildPaymentHeader(payload);
    expect(header.name).toBe("PAYMENT-SIGNATURE");
    expect(header.value).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(parsePaymentPayload(header.value)).toEqual(payload);
    expect(JSON.parse(atob(header.value))).toEqual(payload);
  });

  it("refuses when accepted disagrees with what was signed", async () => {
    const nodeAccount = privateKeyToAccount(generatePrivateKey());
    const signed = await signTransfer({ nodeAccount, treasury: TREASURY, to: ESCROW, value: 8400000n, ttlSeconds: 60, nowSeconds: NOW });
    expect(() => buildPaymentPayload({ accepted: makeRequirements({ amount: "1" }), signed })).toThrow(QuoteMismatchError);
    expect(() =>
      buildPaymentPayload({ accepted: makeRequirements({ payTo: "0x6666666666666666666666666666666666666666" }), signed }),
    ).toThrow(QuoteMismatchError);
  });
});
