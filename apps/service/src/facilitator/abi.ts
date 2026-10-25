import { parseAbi } from "viem";

// ---------------------------------------------------------------------------
// Function ABI the facilitator needs to submit treasury.settle(). The event /
// error ABI the indexer uses lives in chain/abi.ts (its snapshot test pins the
// function list there, so settle() is declared here instead). Signatures copied
// from origin/person1 contracts/src/IOverflowTreasury.sol.
// ---------------------------------------------------------------------------

export const treasurySettleAbi = parseAbi([
  "function settle(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function nodeOfKey(address key) view returns (uint256)",
  "function allowlist(address payee) view returns (bool)",
  "function TOKEN() view returns (address)",
  "event Paid(uint256 indexed id, address indexed to, uint256 value, bytes32 nonce)",
  // Errors so viem decodes a simulation revert by name (same list as chain/abi.ts).
  "error UnknownAgent(address signer)",
  "error PayeeNotAllowed(uint256 node)",
  "error OverPerCall(uint256 node)",
  "error OverBudget(uint256 node)",
  "error Expired(uint256 node)",
  "error Paused(uint256 node)",
  "error BelowFloor()",
  "error TooDeep()",
  "error ChildExceedsParent()",
  "error BadDelegation()",
  "error KeyInUse()",
  "error NotAncestor()",
  "error NotOwner()",
  "error PayeeFlagged(address seller)",
  "error ReservationTooLong()",
  "error ReservationActive()",
]);

/** USDC reads the facilitator uses to confirm (never to move) funds. */
export const usdcSettleAbi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);
