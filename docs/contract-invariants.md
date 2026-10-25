# Contract invariants

Properties OverflowTreasury must hold after every transaction, with the code path that enforces each and the
test that exercises it. Tests run against Circle's compiled USDC v2.2 (`contracts/test/fixtures/usdc-v2_2`),
not a mock. Items marked **P1.5+** come from the spec but are not implemented yet; they are listed so the
invariant suite grows against this file.

## OverflowTreasury (`contracts/src/OverflowTreasury.sol`)

| # | Invariant | Enforced by | Covered by |
| --- | --- | --- | --- |
| T1 | For every node, `spent <= cap`. | `_authorize` reverts `OverBudget(n)` before charging; `raiseCap` only increases `cap`. | `test_OverBudget_child`, `test_sibling_spend_hits_parent_OverBudget`, `test_raiseCap_unblocks_OverBudget_node` |
| T2 | For every node, `spent >= sum of children's spent`. Every payment charges the signer's node and every ancestor by the same `value`. | The walk in `_authorize` charges each level up to the root. | `test_depth2_child_pays_increments_both`, `test_depth3_grandchild_pays_increments_all_three` |
| T3 | No partial charge. If `settle()` reverts for any reason (policy or token), no node's `spent` changes and no USDC moves. | All checks and charges run before the token call inside one transaction, so a token revert unwinds them. | `test_OverBudget_child` (spent unchanged), `test_settle_replay_reverts`, `test_blacklisted_payee_reverts_no_partial_charge` |
| T4 | The treasury balance never drops below `floor` through `settle()`. | `BelowFloor()` when `balanceOf(this) < value + floor`. `withdraw()` is owner-only and may go below the floor by design. | `test_BelowFloor` |
| T5 | `isValidSignature` returns `0x1626ba7e` only when `msg.sender == TOKEN` and only for the digest flagged by the running `settle()`. Outside `settle()`, and for every other caller, it returns `0xffffffff`. | Transient flag at `keccak256(abi.encode(APPROVAL_SALT, digest))` set and cleared around the token call; `view` + `tload` only, so nothing can set it from outside. | `test_gate_closed_outside_settle_for_usdc_and_others`, `test_isValidSignature_inside_settle_scoped_to_token_and_digest`, `test_flagClearedWithinSameTx`, `UsdcReal.t.sol::test_erc1271CallerIsUsdcProxy` |
| T6 | An agent's signed authorization sent straight to USDC never moves funds. The same signature settles only through `settle()`. | USDC's ERC-1271 path reaches `isValidSignature` with no flag set. | `test_direct_to_token_bypass_reverts`, `Adversarial::test_flagClearedWithinSameTx` |
| T7 | A node's authority is bounded by every ancestor: paused, expired, `maxPerCall`, restricted payees and remaining budget are all checked at each level. | The ancestor walk in `_authorize`, in the fixed order Paused, Expired, OverPerCall, PayeeNotAllowed, OverBudget. | `test_PayeeNotAllowed_inherited_from_restricted_ancestor`, `test_Paused_by_owner_blocks_subtree_then_unpause`, `test_pause_middle_node_blocks_grandchild`, `test_pauseChild_by_strict_ancestor_blocks_subtree`, `test_restrictedAncestorEnforcedThroughUnrestrictedMiddle` |
| T8 | A child never has more authority than its parent at creation: `cap`, `maxPerCall`, `expiry` within the parent's; depth at most 2; a restricted parent's child lists only payees the parent allows. | `createChild` checks before writing. | `test_ChildExceedsParent_*`, `test_TooDeep` |
| T9 | Each delegation (CreateChild or PauseChild struct hash) is consumed at most once and only before its deadline, and only the parent (or a strict ancestor for pause) can sign it. | `usedDelegation[structHash]`, deadline check, `ECDSA.recoverCalldata` against `parent.key` / ancestor walk. | `test_BadDelegation_*`, `test_NotAncestor_*`, `test_pauseChild_expired_deadline` |
| T10 | Node keys are unique and never the zero address, the owner or the treasury. | `_checkKey` in `createRoot` and `createChild`. | `test_KeyInUse_*` |
| T11 | Only two paths move USDC out: `settle()` via a flagged authorization, and the owner's `withdraw()`. No other function transfers tokens. | Contract surface. | `test_NotOwner_all_owner_functions`, `test_owner_setAllow_event_and_withdraw` |
| T12 | `settle()` is not reentrant. | OpenZeppelin `ReentrancyGuardTransient`. | Structural; USDC does not call back except the view `isValidSignature` |
| T13 | **P1.5+** The balance is at least `floor + reservedTotal` after every call, and `isValidSignature` is also valid for a live, unexpired reservation of that exact digest. | Not implemented. | None yet |
| T14 | **P1.5+** A payee is either on the global allowlist or a factory-made escrow whose seller is not flagged. | Not implemented (`PayeeNotAllowed(0)` only). | None yet |

## Escrow (spec, not yet implemented)

- Every escrow reaches at most one of `Settled` or `Refunded`, and holds zero USDC afterwards.
- A flagged seller never receives a new payment.

## How to extend

Add a row before changing the contract. Every row needs a code path and at least one test; "structural" is
acceptable only where no transaction can violate the property. The Foundry invariant suite
(`contracts/test/invariant/`, pending) should assert T1, T2, T4 and T5 directly.
