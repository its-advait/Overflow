# Coinbase x402 facilitator with a policy-wallet payer (spike)

## Evidence

Run `pnpm spike:coinbase` on 2026-10-25T04:05:39.536Z. Seller: http://localhost:4402 (throwaway, official `@x402/hono` middleware, facilitator **public**). Payer: treasury [0xd3A74fA991CA0B5627d30EF27dC699C134848291](https://sepolia.basescan.org/address/0xd3A74fA991CA0B5627d30EF27dC699C134848291) on Base Sepolia, USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e. Signer: 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7 (public throwaway test key (not a treasury node key)).

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

Authorization digest `0xb1631dcdcbf1a44f0781c470b20154b479cc963c56523bd80a54dee36cf515a0`, signer 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7 (public throwaway test key (not a treasury node key)).

Response: **HTTP 402**
```
content-type: application/json
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJpbnZhbGlkX2V4YWN0X2V2bV9zaWduYXR1cmUiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwOi8vbG9jYWxob3N0OjQ0MDIvc3Bpa2UvcmVwb3J0IiwiZGVzY3JpcHRpb24iOiJTUElLRTogb25lIHBhaWQgcm91dGUgdG8gdGVzdCBhIHBvbGljeS13YWxsZXQgcGF5ZXIgYWdhaW5zdCBDb2luYmFzZSdzIGZhY2lsaXRhdG9yIiwibWltZVR5cGUiOiJhcHBs…

{}
```
Decoded PAYMENT-REQUIRED (402): error = `invalid_exact_evm_signature`

#### (b) paid request without reserve

`GET http://localhost:4402/spike/report`

Request headers:
```
PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6Miwic2NoZW1lIjoiZXhh…(base64, 968 chars)
```

Fresh nonce, no reserve() call. Digest `0x85d2ddbb5e83c2c59f552c04f9c13d838159377598a57984ad1524cc81b599d9`.

Response: **HTTP 402**
```
content-type: application/json
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJpbnZhbGlkX2V4YWN0X2V2bV9zaWduYXR1cmUiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwOi8vbG9jYWxob3N0OjQ0MDIvc3Bpa2UvcmVwb3J0IiwiZGVzY3JpcHRpb24iOiJTUElLRTogb25lIHBhaWQgcm91dGUgdG8gdGVzdCBhIHBvbGljeS13YWxsZXQgcGF5ZXIgYWdhaW5zdCBDb2luYmFzZSdzIGZhY2lsaXRhdG9yIiwibWltZVR5cGUiOiJhcHBs…

{}
```
Decoded PAYMENT-REQUIRED (402): error = `invalid_exact_evm_signature`

#### (c) expired authorization (validBefore 2 minutes ago)

`GET http://localhost:4402/spike/report`

Request headers:
```
PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6Miwic2NoZW1lIjoiZXhh…(base64, 968 chars)
```

Stands in for an expired reservation: once validBefore passes, USDC and every facilitator refuse the authorization regardless of the treasury's reservation state. Digest `0xc70c8eabbe5d58bb81648eaeae8c59d25a26f29205bd7ba89709a2709698a6d7`.

Response: **HTTP 402**
```
content-type: application/json
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJpbnZhbGlkX2V4YWN0X2V2bV9zaWduYXR1cmUiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwOi8vbG9jYWxob3N0OjQ0MDIvc3Bpa2UvcmVwb3J0IiwiZGVzY3JpcHRpb24iOiJTUElLRTogb25lIHBhaWQgcm91dGUgdG8gdGVzdCBhIHBvbGljeS13YWxsZXQgcGF5ZXIgYWdhaW5zdCBDb2luYmFzZSdzIGZhY2lsaXRhdG9yIiwibWltZVR5cGUiOiJhcHBs…

{}
```
Decoded PAYMENT-REQUIRED (402): error = `invalid_exact_evm_signature`

### Case summary

- (a) reserve unavailable: HTTP 402, body {} error=invalid_exact_evm_signature
- (b) without reserve: HTTP 402, body {} error=invalid_exact_evm_signature
- (c) expired: HTTP 402, body {} error=invalid_exact_evm_signature
