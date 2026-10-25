import { describe, expect, it, vi } from "vitest";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { CdpClientLike } from "@overflow/payment-client/signers";
import { readConfig } from "./config";

// SIMULATED keys, never funded.
const KEY = keccak256(toHex("overflow.simulated.overflow-mcp-config-env"));
const CDP = privateKeyToAccount(keccak256(toHex("overflow.simulated.overflow-mcp-config-cdp")));
const CREDS = { CDP_API_KEY_ID: "not-a-real-id", CDP_API_KEY_SECRET: "not-a-real-secret", CDP_WALLET_SECRET: "not-a-real-wallet-secret" };

const fakeCdp = (): CdpClientLike => {
  const account = { address: CDP.address, signTypedData: (td: unknown) => CDP.signTypedData(td as Parameters<typeof CDP.signTypedData>[0]) };
  return { evm: { getAccount: async () => account, getOrCreateAccount: async () => account } };
};

describe("readConfig", () => {
  it("env-key path: defaults, trailing-slash trim, public RPC fallback, no CDP client loaded", async () => {
    const cdp = vi.fn(fakeCdp);
    const c = await readConfig({ NODE_PRIVATE_KEY: KEY, SERVICE_URL: "http://svc.test/" }, { cdp });
    expect(c.serviceUrl).toBe("http://svc.test");
    expect(c.rpcSource).toBe("public fallback");
    expect(c.treasuryPin).toBeNull();
    expect(c.signer).toMatchObject({ kind: "env-key", address: privateKeyToAccount(KEY).address });
    expect(cdp).not.toHaveBeenCalled();
  });

  it("NODE_SIGNER=cdp resolves the CDP account through the injected client", async () => {
    const c = await readConfig({ NODE_SIGNER: "cdp", ...CREDS, CDP_ACCOUNT_NAME: "overflow-node-root", BASE_SEPOLIA_RPC_URL: "http://rpc.test" }, { cdp: fakeCdp });
    expect(c.signer).toMatchObject({ kind: "cdp", source: "cdp:overflow-node-root", address: CDP.address });
    expect(c.rpcSource).toBe("BASE_SEPOLIA_RPC_URL");
  });

  it("NODE_SIGNER=cdp without the wallet secret names it and loads nothing", async () => {
    const cdp = vi.fn(fakeCdp);
    const { CDP_WALLET_SECRET: _omit, ...partial } = CREDS;
    await expect(readConfig({ NODE_SIGNER: "cdp", ...partial, CDP_ACCOUNT_NAME: "overflow-node-root" }, { cdp })).rejects.toThrow(/CDP_WALLET_SECRET/);
    expect(cdp).not.toHaveBeenCalled();
  });

  it("refuses CHAIN_ID other than 84532 and a missing node key", async () => {
    await expect(readConfig({ NODE_PRIVATE_KEY: KEY, CHAIN_ID: "1" })).rejects.toThrow(/CHAIN_ID must be 84532/);
    await expect(readConfig({})).rejects.toThrow(/NODE_ACCOUNT/);
  });

  it("ignores the retired NODE_CDP_ACCOUNT variable", async () => {
    const c = await readConfig({ NODE_PRIVATE_KEY: KEY, NODE_CDP_ACCOUNT: "anything" });
    expect(c.signer.kind).toBe("env-key");
  });
});
