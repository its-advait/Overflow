# Test fixtures

`throwaway-a11ce`: a Foundry keystore made with `cast wallet import throwaway-a11ce --private-key 0x…0a11ce
--unsafe-password overflow-throwaway-fixture-password`. The key is the public test vector used across this repo
(`0x` + `a11ce` left-padded to 64 hex), never a real wallet. Used only by `src/keystore.test.ts`.
