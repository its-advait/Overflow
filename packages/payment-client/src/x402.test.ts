import { describe, expect, it } from "vitest";
import {
  PaymentRequiredParseError,
  X402_HEADERS,
  decodeBase64Json,
  encodeBase64Json,
  parsePaymentPayload,
  parsePaymentRequired,
  parsePaymentResponse,
} from "./index";

// Verbatim examples from github.com/x402-foundation/x402 specs/transports-v2/http.md.
const SPEC_PAYMENT_REQUIRED =
  "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcmVtaXVtLWRhdGEiLCJkZXNjcmlwdGlvbiI6IkFjY2VzcyB0byBwcmVtaXVtIG1hcmtldCBkYXRhIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUzODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fV19";
const SPEC_PAYMENT_SIGNATURE =
  "eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcHJlbWl1bS1kYXRhIiwiZGVzY3JpcHRpb24iOiJBY2Nlc3MgdG8gcHJlbWl1bSBtYXJrZXQgZGF0YSIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LCJhY2NlcHRlZCI6eyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiMHgwMzZDYkQ1Mzg0MmM1NDI2NjM0ZTc5Mjk1NDFlQzIzMThmM2RDRjdlIiwicGF5VG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJtYXhUaW1lb3V0U2Vjb25kcyI6NjAsImV4dHJhIjp7Im5hbWUiOiJVU0RDIiwidmVyc2lvbiI6IjIifX0sInBheWxvYWQiOnsic2lnbmF0dXJlIjoiMHgyZDZhNzU4OGQ2YWNjYTUwNWNiZjBkOWE0YTIyN2UwYzUyYzZjMzQwMDhjOGU4OTg2YTEyODMyNTk3NjQxNzM2MDhhMmNlNjQ5NjY0MmUzNzdkNmRhOGRiYmY1ODM2ZTliZDE1MDkyZjllY2FiMDVkZWQzZDYyOTNhZjE0OGI1NzFjIiwiYXV0aG9yaXphdGlvbiI6eyJmcm9tIjoiMHg4NTdiMDY1MTlFOTFlM0E1NDUzODc5MWJEYmIwRTIyMzczZTM2YjY2IiwidG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJ2YWx1ZSI6IjEwMDAwIiwidmFsaWRBZnRlciI6IjE3NDA2NzIwODkiLCJ2YWxpZEJlZm9yZSI6IjE3NDA2NzIxNTQiLCJub25jZSI6IjB4ZjM3NDY2MTNjMmQ5MjBiNWZkYWJjMDg1NmYyYWViMmQ0Zjg4ZWU2MDM3YjhjYzVkMDRhNzFhNDQ2MmYxMzQ4MCJ9fX0=";
const SPEC_PAYMENT_RESPONSE_OK =
  "eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWYxMjM0NTY3ODkwYWJjZGVmMTIzNDU2Nzg5MGFiY2RlZiIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9";
const SPEC_PAYMENT_RESPONSE_FAIL =
  "eyJzdWNjZXNzIjpmYWxzZSwiZXJyb3JSZWFzb24iOiJpbnN1ZmZpY2llbnRfZnVuZHMiLCJ0cmFuc2FjdGlvbiI6IiIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9";

function res(status: number, headers: Record<string, string>) {
  return { status, headers: new Headers(headers) };
}

describe("x402 v2 header names", () => {
  it("match specs/transports-v2/http.md", () => {
    expect(X402_HEADERS).toEqual({
      paymentRequired: "PAYMENT-REQUIRED",
      paymentSignature: "PAYMENT-SIGNATURE",
      paymentResponse: "PAYMENT-RESPONSE",
    });
  });
});

describe("base64 JSON codec", () => {
  it("round-trips and matches the spec encoding of the spec example", () => {
    const decoded = decodeBase64Json(SPEC_PAYMENT_REQUIRED);
    expect(encodeBase64Json(decoded)).toBe(SPEC_PAYMENT_REQUIRED);
    expect(encodeBase64Json({ a: "ü" })).toBe(btoa("{\"a\":\"\xc3\xbc\"}"));
    expect(decodeBase64Json(encodeBase64Json({ a: "ü" }))).toEqual({ a: "ü" });
  });
  it("rejects non-base64 and non-JSON", () => {
    expect(() => decodeBase64Json("not base64!")).toThrow(PaymentRequiredParseError);
    expect(() => decodeBase64Json(btoa("not json"))).toThrow(PaymentRequiredParseError);
  });
});

describe("parsePaymentRequired", () => {
  it("decodes the spec's PAYMENT-REQUIRED example", () => {
    const pr = parsePaymentRequired(res(402, { "PAYMENT-REQUIRED": SPEC_PAYMENT_REQUIRED }));
    expect(pr.x402Version).toBe(2);
    expect(pr.error).toBe("PAYMENT-SIGNATURE header is required");
    expect(pr.resource.url).toBe("https://api.example.com/premium-data");
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).toEqual({
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    });
  });
  it("is case-insensitive on the header name (Headers semantics)", () => {
    expect(() => parsePaymentRequired(res(402, { "payment-required": SPEC_PAYMENT_REQUIRED }))).not.toThrow();
  });
  it("requires status 402 when a status is given", () => {
    expect(() => parsePaymentRequired(res(200, { "PAYMENT-REQUIRED": SPEC_PAYMENT_REQUIRED }))).toThrow(/expected HTTP 402/);
  });
  it("requires the header; bodies are not protocol data", () => {
    expect(() => parsePaymentRequired(res(402, {}))).toThrow(/missing PAYMENT-REQUIRED/);
  });
  it("rejects x402 v1 and malformed objects", () => {
    const v1 = encodeBase64Json({ x402Version: 1, accepts: [] });
    expect(() => parsePaymentRequired(res(402, { "PAYMENT-REQUIRED": v1 }))).toThrow(PaymentRequiredParseError);
    const noAccepts = encodeBase64Json({ x402Version: 2, resource: { url: "https://x" }, accepts: [] });
    expect(() => parsePaymentRequired(res(402, { "PAYMENT-REQUIRED": noAccepts }))).toThrow(/accepts/);
    const badNetwork = encodeBase64Json({
      x402Version: 2,
      resource: { url: "https://x" },
      accepts: [{ scheme: "exact", network: "base-sepolia", amount: "1", asset: "0x", payTo: "0x", maxTimeoutSeconds: 1 }],
    });
    expect(() => parsePaymentRequired(res(402, { "PAYMENT-REQUIRED": badNetwork }))).toThrow(/CAIP-2/);
  });
});

describe("parsePaymentPayload", () => {
  it("decodes the spec's PAYMENT-SIGNATURE example", () => {
    const p = parsePaymentPayload(SPEC_PAYMENT_SIGNATURE);
    expect(p.accepted.payTo).toBe("0x209693Bc6afc0C5328bA36FaF03C514EF312287C");
    expect(p.payload.authorization).toEqual({
      from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      value: "10000",
      validAfter: "1740672089",
      validBefore: "1740672154",
      nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
    });
    expect(p.payload.signature).toHaveLength(2 + 65 * 2);
  });
});

describe("parsePaymentResponse", () => {
  it("decodes success and failure examples", () => {
    const ok = parsePaymentResponse(res(200, { "PAYMENT-RESPONSE": SPEC_PAYMENT_RESPONSE_OK }));
    expect(ok).toMatchObject({
      success: true,
      transaction: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      network: "eip155:84532",
      payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    });
    const fail = parsePaymentResponse(res(402, { "PAYMENT-RESPONSE": SPEC_PAYMENT_RESPONSE_FAIL }));
    expect(fail).toMatchObject({ success: false, errorReason: "insufficient_funds", transaction: "" });
  });
  it("returns null when absent and throws when malformed", () => {
    expect(parsePaymentResponse(res(200, {}))).toBeNull();
    expect(() => parsePaymentResponse(res(200, { "PAYMENT-RESPONSE": btoa("{}") }))).toThrow(PaymentRequiredParseError);
  });
});
