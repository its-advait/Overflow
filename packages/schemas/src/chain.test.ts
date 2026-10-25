import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainSeparator } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAIN_ID,
  DEPLOYMENTS_RELATIVE_PATH,
  DeploymentsSchema,
  OVERFLOW_DELEGATION_DOMAIN,
  USDC,
  USDC_DECIMALS,
  USDC_EIP712_DOMAIN,
  AddressSchema,
  defaultDeploymentsPath,
  explorerUrl,
  loadDeployments,
  parseDeployments,
} from "./index";

describe("USDC facts", () => {
  it("pins chain constants", () => {
    expect(CHAIN_ID).toBe(84532);
    expect(USDC_DECIMALS).toBe(6);
    expect(USDC.decimals).toBe(6);
    expect(USDC.chainId).toBe(84532);
    expect(USDC.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(AddressSchema.safeParse(USDC.address).success).toBe(true);
    expect(AddressSchema.safeParse("0x1234").success).toBe(false);
  });

  it("viem's domainSeparator for {USDC, 2, 84532, address} equals the pinned constant", () => {
    const computed = domainSeparator({
      domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: USDC.address,
      },
    });
    expect(computed).toBe(USDC.domainSeparator);
    expect(domainSeparator({ domain: USDC_EIP712_DOMAIN })).toBe(USDC.domainSeparator);
    expect(USDC.domainSeparator).toBe(
      "0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818",
    );
  });

  it("a different name, version or chain gives a different separator", () => {
    expect(domainSeparator({ domain: { ...USDC_EIP712_DOMAIN, version: "1" } })).not.toBe(
      USDC.domainSeparator,
    );
    expect(domainSeparator({ domain: { ...USDC_EIP712_DOMAIN, chainId: 8453 } })).not.toBe(
      USDC.domainSeparator,
    );
    expect(domainSeparator({ domain: { ...USDC_EIP712_DOMAIN, name: "USD Coin" } })).not.toBe(
      USDC.domainSeparator,
    );
  });

  it("delegation domain is Overflow v1 on Base Sepolia", () => {
    expect(OVERFLOW_DELEGATION_DOMAIN).toEqual({ name: "Overflow", version: "1", chainId: 84532 });
  });
});

describe("explorerUrl", () => {
  it("builds Basescan Sepolia links", () => {
    const tx = `0x${"ab".repeat(32)}`;
    expect(explorerUrl("tx", tx)).toBe(`https://sepolia.basescan.org/tx/${tx}`);
    expect(explorerUrl("address", USDC.address)).toBe(
      `https://sepolia.basescan.org/address/${USDC.address}`,
    );
    expect(explorerUrl("block", 123n)).toBe("https://sepolia.basescan.org/block/123");
    expect(explorerUrl("block", 456)).toBe("https://sepolia.basescan.org/block/456");
  });
});

describe("deployments", () => {
  const valid = {
    chainId: 84532,
    treasury: "0x1111111111111111111111111111111111111111",
    escrowFactory: "0x2222222222222222222222222222222222222222",
  };

  it("parses a valid file and defaults token, usdc, txs and the escrow addresses", () => {
    const d = parseDeployments({ chainId: 84532, treasury: valid.treasury });
    expect(d.usdc).toBe(USDC.address);
    expect(d.token).toBe(USDC.address);
    expect(d.treasury).toBe(valid.treasury);
    expect(d.escrowFactory).toBeNull();
    expect(d.escrowImplementation).toBeNull();
    expect(d.txs).toEqual({});
    expect(parseDeployments(valid).escrowFactory).toBe(valid.escrowFactory);
  });

  it("accepts the full file the deploy script writes", () => {
    const d = parseDeployments({
      ...valid,
      token: USDC.address,
      owner: "0x3333333333333333333333333333333333333333",
      deployer: "0x3333333333333333333333333333333333333333",
      deployBlock: "12345",
      deployedAt: "2026-10-24T18:00:00.000Z",
      txs: { treasury: `0x${"ab".repeat(32)}` },
    });
    expect(d.owner).toBe("0x3333333333333333333333333333333333333333");
    expect(d.txs["treasury"]).toBe(`0x${"ab".repeat(32)}`);
  });

  it("rejects a wrong chain id or missing addresses", () => {
    expect(DeploymentsSchema.safeParse({ ...valid, chainId: 8453 }).success).toBe(false);
    expect(DeploymentsSchema.safeParse({ ...valid, treasury: undefined }).success).toBe(false);
    expect(DeploymentsSchema.safeParse({ ...valid, escrowFactory: "0x12" }).success).toBe(false);
  });

  it("default path is packages/schemas/deployments/base-sepolia.json", async () => {
    const p = await defaultDeploymentsPath();
    expect(p.endsWith(DEPLOYMENTS_RELATIVE_PATH)).toBe(true);
    expect(p).toContain("packages/schemas/deployments");
    expect(p).not.toContain("src");
  });

  describe("loadDeployments", () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "overflow-schemas-"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("round-trips a written file", async () => {
      const file = join(dir, "base-sepolia.json");
      await writeFile(file, JSON.stringify({ ...valid, deployBlock: "123", txHashes: {} }));
      const d = await loadDeployments(file);
      expect(d.treasury).toBe(valid.treasury);
      expect(d.deployBlock).toBe("123");
      expect(d.usdc).toBe(USDC.address);
    });

    it("names the path when the file is missing", async () => {
      const missing = join(dir, "nope.json");
      await expect(loadDeployments(missing)).rejects.toThrow(missing);
    });

    it("rejects an invalid file", async () => {
      const file = join(dir, "bad.json");
      await writeFile(file, JSON.stringify({ ...valid, chainId: 1 }));
      await expect(loadDeployments(file)).rejects.toThrow();
    });
  });
});
