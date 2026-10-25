/**
 * Node-only: load a signer from a Foundry (Web3 Secret Storage v3) keystore without the key ever leaving this
 * process. `cast wallet import <name>` writes ~/.foundry/keystores/<name>; the service and scripts decrypt it in
 * memory with a password read from a chmod-600 file, build a viem account and discard the buffers. Nothing here
 * logs, returns or serialises the key beyond the account object itself. Imported as
 * `@overflow/payment-client/keystore` (not from the package root, which stays browser-safe).
 */
import { createDecipheriv, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";

const hex = (bytes?: number) => z.string().regex(bytes ? new RegExp(`^(0x)?[0-9a-fA-F]{${bytes * 2}}$`) : /^(0x)?[0-9a-fA-F]*$/);

/** The subset of Web3 Secret Storage v3 that Foundry (eth-keystore-rs) writes: scrypt + aes-128-ctr. */
export const KeystoreSchema = z.object({
  version: z.literal(3),
  address: z.string().optional(),
  crypto: z.object({
    cipher: z.literal("aes-128-ctr"),
    cipherparams: z.object({ iv: hex(16) }),
    ciphertext: hex(32),
    kdf: z.literal("scrypt"),
    kdfparams: z.object({
      dklen: z.literal(32),
      n: z.number().int().min(2).max(2 ** 24),
      r: z.number().int().min(1).max(64),
      p: z.number().int().min(1).max(16),
      salt: hex(),
    }),
    mac: hex(32),
  }),
});
export type Keystore = z.infer<typeof KeystoreSchema>;

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeystoreError";
  }
}

const buf = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");

/** Decrypt a v3 keystore. A wrong password fails the MAC check before any decryption. Returns the 32-byte key. */
export function decryptKeystore(json: unknown, password: string): Hex {
  const parsed = KeystoreSchema.safeParse(json);
  if (!parsed.success) throw new KeystoreError(`unsupported keystore: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  const { crypto } = parsed.data;
  const { n, r, p, salt, dklen } = crypto.kdfparams;
  const derived = scryptSync(Buffer.from(password, "utf8"), buf(salt), dklen, { N: n, r, p, maxmem: 256 * n * r + 2 ** 20 });
  const ciphertext = buf(crypto.ciphertext);
  const mac = buf(keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])));
  const ok = timingSafeEqual(mac, buf(crypto.mac));
  if (!ok) {
    derived.fill(0);
    throw new KeystoreError("keystore MAC mismatch: wrong password or corrupted file");
  }
  const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), buf(crypto.cipherparams.iv));
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  derived.fill(0);
  const out = `0x${key.toString("hex")}` as Hex;
  key.fill(0);
  return out;
}

/** `~/.foundry/keystores/<name>` (or `$FOUNDRY_KEYSTORES_DIR/<name>`); an absolute path is used as is. */
export function resolveKeystorePath(nameOrPath: string, keystoresDir?: string): string {
  if (isAbsolute(nameOrPath)) return nameOrPath;
  if (nameOrPath.includes("/")) throw new KeystoreError(`keystore '${nameOrPath}' must be a name under the keystores dir or an absolute path`);
  return join(keystoresDir ?? process.env["FOUNDRY_KEYSTORES_DIR"] ?? join(homedir(), ".foundry", "keystores"), nameOrPath);
}

/** Read a password file that only its owner can read (mode 0600 or stricter). Trailing newlines are dropped. */
export function readPasswordFile(path: string): string {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new KeystoreError(`password file ${path} is missing`);
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new KeystoreError(`password file ${path} is readable by group/others; chmod 600 it`);
  }
  const text = readFileSync(path, "utf8").replace(/[\r\n]+$/, "");
  if (!text) throw new KeystoreError(`password file ${path} is empty`);
  return text;
}

export type SignerSource = {
  /** Env slot that holds either a 0x 64-hex key or just the signer's address (keystore flow). */
  keyOrAddress?: string | undefined;
  /** Foundry keystore name (cast wallet list) or absolute path. */
  account?: string | undefined;
  passwordFile?: string | undefined;
  keystoresDir?: string | undefined;
  /** Used in error messages, e.g. "RELAYER". */
  label: string;
};

export type ResolvedSigner = { account: PrivateKeyAccount; source: string };

/**
 * Pick the signer for one role. Precedence: a 64-hex key in the env slot; otherwise the keystore named by
 * `account` + `passwordFile`. When the env slot holds an address, the decrypted key must match it.
 */
export function resolveSigner(src: SignerSource): ResolvedSigner {
  const slot = (src.keyOrAddress ?? "").trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(slot)) return { account: privateKeyToAccount(slot as Hex), source: `${src.label}_PRIVATE_KEY (env)` };
  let expected: Address | undefined;
  if (slot) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(slot)) throw new KeystoreError(`${src.label} env slot must be a 0x 64-hex key or a 0x address`);
    expected = getAddress(slot);
  }
  if (!src.account || !src.passwordFile) {
    throw new KeystoreError(
      `${src.label}: set ${src.label}_ACCOUNT (Foundry keystore name) and ${src.label}_PASSWORD_FILE (chmod 600), or a 64-hex key in the env slot`,
    );
  }
  const path = resolveKeystorePath(src.account, src.keystoresDir);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new KeystoreError(`${src.label}: keystore ${path} is missing or not JSON`);
  }
  const account = privateKeyToAccount(decryptKeystore(json, readPasswordFile(src.passwordFile)));
  if (expected && account.address !== expected) {
    throw new KeystoreError(`${src.label}: keystore ${src.account} holds ${account.address}, but the env slot says ${expected}`);
  }
  return { account, source: `keystore ${src.account}` };
}
