# Coinbase x402 facilitator with a policy-wallet payer (spike)

**Verdict (2026-10-25): Coinbase's CDP facilitator does not reject a contract payer outright, but settlement through it with a live `reserve()` is UNPROVEN because the deployed treasury predates `reserve()`; the Coinbase adapter stays BLOCKED and the demo runs the Overflow path, labeled.**

Spike, throwaway code: `apps/service/src/sellers/spike/server.ts` (official `@x402/hono` 2.28.0 middleware, one paid route, $0.01 USDC on Base Sepolia, facilitator `https://api.cdp.coinbase.com/platform/v2/x402` authenticated with our CDP API key through `@coinbase/x402` 2.1.0) and `scripts/coinbase-spike.ts` (`pnpm spike:coinbase`; signs `TransferWithAuthorization` with `from = treasury` and records every request and response). Time spent: about 40 minutes of the 90-minute box. No transaction was broadcast; every call below is a verify-stage rejection. The signer was the public throwaway test key, so no treasury node key was used.

## What worked

- The official seller middleware runs against the CDP facilitator with our key. `GET /spike/report` returns 402 with a correct `PAYMENT-REQUIRED` header (exact, `eip155:84532`, USDC, amount `10000`, `extra {name: "USDC", version: "2"}`), and the CDP `/supported` endpoint lists `exact`, `upto` and `batch-settlement` for `eip155:84532`.
- Our payment payload shape is accepted by the middleware once `accepted` deep-equals the quoted entry (an extra `resource` field is rejected with `No matching payment requirements`; the adapters already send the quote unchanged).
- The CDP facilitator treats a contract payer differently from the public `x402.org` facilitator. The public one recovers an EOA and stops: `invalid_exact_evm_signature` for every treasury-as-payer request, including the expired one. The CDP one passed the signature stage for the treasury and failed in an onchain simulation.

## Exact errors

| Case | Facilitator | Error (verbatim, from the 402 `PAYMENT-REQUIRED` header) |
|---|---|---|
| (a) with reserve | CDP | `invalid_payload: contract call failed: unable to call contract: execution reverted` (reservation step unavailable, see below) |
| (b) without reserve | CDP | `invalid_payload: contract call failed: unable to call contract: execution reverted` |
| (c) expired (validBefore in the past) | CDP | `invalid_exact_evm_payload_authorization_valid_before: valid before expired: 1792901015` |
| (a), (b), (c) | public x402.org | `invalid_exact_evm_signature` |

Differential probes straight at CDP `/verify` (same payload shape, authenticated client):

| Payer | Signature | Error |
|---|---|---|
| EOA, 0 USDC | valid, by itself | `invalid_payload: contract call failed: unable to call contract: execution reverted` |
| EOA | by a different key | `invalid_exact_evm_payload_signature: invalid signature: 0x…` |
| USDC contract (no ERC-1271) | by the throwaway key | `invalid_exact_evm_payload_signature: contract call failed: unable to call contract: execution reverted` |
| treasury (ERC-1271 only for USDC) | by the throwaway key | `invalid_payload: contract call failed: unable to call contract: execution reverted` |

Reading: a wrong EOA signature fails at the signature stage; a valid EOA signature with no balance fails later with the same `invalid_payload` revert we get for the treasury. A contract with no `isValidSignature` fails at the signature stage. So for the treasury the facilitator got past its signature check and simulated the transfer; the simulation reverted. On the live treasury that is the only possible outcome: it has no `reserve()` (the deployed bytecode predates it, `reservationWindow()` and `escrowFactory()` both revert), holds 0 USDC, and without a live reservation `isValidSignature` returns INVALID so USDC reverts `FiatTokenV2: invalid signature`.

### Why case (a) could not be proven

`POST /reserve` needs our facilitator service, which cannot boot here (no `RELAYER_PASSWORD_FILE`), and the live treasury has no `reserve()` to call. Redeploying is outside this spike. The expired case (c) stands in for an expired reservation: once `validBefore` passes, the facilitator rejects before any contract call, and the treasury's `release()` returns the agent's allowance.

## Our workaround

Keep the Overflow facilitator as the demo path: our own relayer submits `treasury.settle()` and USDC asks the treasury (ERC-1271) inside the same transaction. The `CoinbaseFacilitatorAdapter` stays BLOCKED and labeled; it already models the rejection (PAYMENT_PENDING with the facilitator's reason, then `/release` after `validBefore`). Passing adapter unit tests do not prove live settlement through Coinbase. If the redeploy lands with `reserve()` and treasury USDC, rerun `pnpm spike:coinbase` with the service up to settle case (a) for real.

## The one capability we'd ask Coinbase for

Surface the simulated revert reason instead of the opaque `contract call failed: unable to call contract: execution reverted`, and document ERC-1271 payers whose validity is only visible to the token (`msg.sender == USDC`). Today a policy wallet that gates `isValidSignature` on the caller cannot tell "no balance" from "no reservation" from "wrong signer", and cannot know from the docs whether the facilitator will ever reach `transferWithAuthorization` for it.

## Public facilitator (x402.org) for comparison

Full record in `docs/coinbase-feedback-public.md`. Summary:

- (a) reserve unavailable: HTTP 402, body {} error=invalid_exact_evm_signature
- (b) without reserve: HTTP 402, body {} error=invalid_exact_evm_signature
- (c) expired: HTTP 402, body {} error=invalid_exact_evm_signature

## Evidence

Run `pnpm spike:coinbase` on 2026-10-25T04:05:35.899Z. Seller: http://localhost:4402 (throwaway, official `@x402/hono` middleware, facilitator **cdp**). Payer: treasury [0xd3A74fA991CA0B5627d30EF27dC699C134848291](https://sepolia.basescan.org/address/0xd3A74fA991CA0B5627d30EF27dC699C134848291) on Base Sepolia, USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e. Signer: 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7 (public throwaway test key (not a treasury node key)).

#### Quote (402)

`GET http://localhost:4402/spike/report`

Response: **HTTP 402**
```
content-type: application/json
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cDovL2xvY2FsaG9zdDo0NDAyL3NwaWtlL3JlcG9ydCIsImRlc2NyaXB0aW9uIjoiU1BJS0U6IG9uZSBwYWlkIHJvdXRlIHRvIHRlc3QgYSBwb2xpY3ktd2FsbGV0IHBheWVyIGFnYWluc3QgQ29pbmJhc2UncyBmYWNpbGl0YXRvciIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNv…

{}
```
Decoded PAYMENT-REQUIRED (402): error = `Payment required`

Decoded PAYMENT-REQUIRED header:
```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:4402/spike/report",
    "description": "SPIKE: one paid route to test a policy-wallet payer against Coinbase's facilitator",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x1111111111111111111111111111111111111111",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    }
  ]
}
```

#### (a) step 1: reserve through the Overflow facilitator

`POST http://localhost:4099/reserve`

**Reservation step unavailable**: http://localhost:4099/reserve is unreachable (fetch failed). The paid request below therefore runs without an onchain reservation.

#### (a) step 2: paid request WITHOUT (see step 1) a live reservation

`GET http://localhost:4402/spike/report`

Request headers:
```
PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6Miwic2NoZW1lIjoiZXhh…(base64, 968 chars)
```

**Reservation step unavailable**: http://localhost:4099/reserve is unreachable (fetch failed). The paid request below therefore runs without an onchain reservation.

Authorization digest `0x7069bd68d273310182474982c8b74e675d981a5b82aab787fcb9bfa5382c5c00`, signer 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7 (public throwaway test key (not a treasury node key)).

Response: **HTTP 402**
```
content-type: application/json
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJpbnZhbGlkX3BheWxvYWQ6IGNvbnRyYWN0IGNhbGwgZmFpbGVkOiB1bmFibGUgdG8gY2FsbCBjb250cmFjdDogZXhlY3V0aW9uIHJldmVydGVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cDovL2xvY2FsaG9zdDo0NDAyL3NwaWtlL3JlcG9ydCIsImRlc2NyaXB0aW9uIjoiU1BJS0U6IG9uZSBwYWlkIHJvdXRlIHRvIHRlc3QgYSBwb2xpY3ktd2FsbGV0…

{}
```
Decoded PAYMENT-REQUIRED (402): error = `invalid_payload: contract call failed: unable to call contract: execution reverted`

#### (b) paid request without reserve

`GET http://localhost:4402/spike/report`

Request headers:
```
PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6Miwic2NoZW1lIjoiZXhh…(base64, 968 chars)
```

Fresh nonce, no reserve() call. Digest `0x401d0b44b51b6fd3db53dff36f6fe4f8304e57b28a1af7f2936465ab473ba102`.

Response: **HTTP 402**
```
content-type: application/json
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJpbnZhbGlkX3BheWxvYWQ6IGNvbnRyYWN0IGNhbGwgZmFpbGVkOiB1bmFibGUgdG8gY2FsbCBjb250cmFjdDogZXhlY3V0aW9uIHJldmVydGVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cDovL2xvY2FsaG9zdDo0NDAyL3NwaWtlL3JlcG9ydCIsImRlc2NyaXB0aW9uIjoiU1BJS0U6IG9uZSBwYWlkIHJvdXRlIHRvIHRlc3QgYSBwb2xpY3ktd2FsbGV0…

{}
```
Decoded PAYMENT-REQUIRED (402): error = `invalid_payload: contract call failed: unable to call contract: execution reverted`

#### (c) expired authorization (validBefore 2 minutes ago)

`GET http://localhost:4402/spike/report`

Request headers:
```
PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6Miwic2NoZW1lIjoiZXhh…(base64, 968 chars)
```

Stands in for an expired reservation: once validBefore passes, USDC and every facilitator refuse the authorization regardless of the treasury's reservation state. Digest `0xe5d6542f6433fe4e2e1314a85bfe038da75341638f3bfc071d2cbd91d3e3132a`.

Response: **HTTP 402**
```
content-type: application/json
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJpbnZhbGlkX2V4YWN0X2V2bV9wYXlsb2FkX2F1dGhvcml6YXRpb25fdmFsaWRfYmVmb3JlOiB2YWxpZCBiZWZvcmUgZXhwaXJlZDogMTc5MjkwMTAxNSIsInJlc291cmNlIjp7InVybCI6Imh0dHA6Ly9sb2NhbGhvc3Q6NDQwMi9zcGlrZS9yZXBvcnQiLCJkZXNjcmlwdGlvbiI6IlNQSUtFOiBvbmUgcGFpZCByb3V0ZSB0byB0ZXN0IGEgcG9saWN5LXdh…

{}
```
Decoded PAYMENT-REQUIRED (402): error = `invalid_exact_evm_payload_authorization_valid_before: valid before expired: 1792901015`

### Case summary

- (a) reserve unavailable: HTTP 402, body {} error=invalid_payload: contract call failed: unable to call contract: execution reverted
- (b) without reserve: HTTP 402, body {} error=invalid_payload: contract call failed: unable to call contract: execution reverted
- (c) expired: HTTP 402, body {} error=invalid_exact_evm_payload_authorization_valid_before: valid before expired: 1792901015
