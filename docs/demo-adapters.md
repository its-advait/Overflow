# Payment adapters on Base Sepolia

Run by `pnpm demo:adapters --probe-coinbase` on 2026-10-25T03:52:32.846Z against treasury [0xd3A74fA991CA0B5627d30EF27dC699C134848291](https://sepolia.basescan.org/address/0xd3A74fA991CA0B5627d30EF27dC699C134848291); agent signer 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7 (public throwaway test key (probe only)). Sellers are SIMULATED local x402 servers.

| Step | Result | Detail | Transaction |
|---|---|---|---|
| P3.4 probe: Coinbase facilitator /verify with payer = treasury (ERC-1271 only) | `POST https://x402.org/facilitator/verify` | HTTP 200: {"isValid":false,"invalidReason":"invalid_exact_evm_signature","payer":"0xd3A74fA991CA0B5627d30EF27dC699C134848291"} | — (read-only) |
