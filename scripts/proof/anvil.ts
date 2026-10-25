import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// A local anvil that forks Base Sepolia for `pnpm proof --fork`. The fork URL
// comes from BASE_SEPOLIA_RPC_URL (loaded by code, never printed): anvil's own
// output can echo it, so stdout/stderr are kept in memory and redacted before
// anything is shown. The process is killed on every exit path of the runner.
// ---------------------------------------------------------------------------

export const ANVIL_BIN = process.env["ANVIL_BIN"] ?? join(homedir(), ".foundry", "bin", "anvil");

export interface Anvil {
  url: string;
  port: number;
  version: string;
  stop(): Promise<void>;
}

/** True when nothing listens on `port` (lsof says so and a bind on 127.0.0.1 succeeds). */
async function portFree(port: number): Promise<boolean> {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    if (out.trim().length > 0) return false;
  } catch {
    // lsof exits 1 when nothing matches: free as far as lsof can tell.
  }
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

export async function pickFreePort(start = 8645, attempts = 50): Promise<number> {
  for (let p = start; p < start + attempts; p++) if (await portFree(p)) return p;
  throw new Error(`no free port in ${start}..${start + attempts - 1}`);
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("<redacted>");
  return out;
}

const live = new Set<ChildProcess>();
let hooked = false;
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  const killAll = () => {
    for (const c of live) if (c.exitCode === null) c.kill("SIGKILL");
  };
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      killAll();
      process.exit(130);
    });
  }
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
  return body.result;
}

/** Starts anvil forking `forkUrl` on a free port and waits until it answers eth_chainId. */
export async function startAnvil(opts: { forkUrl: string; log: (line: string) => void; forkBlockNumber?: bigint | undefined }): Promise<Anvil> {
  hookExit();
  const version = execFileSync(ANVIL_BIN, ["--version"]).toString().split("\n")[0]?.trim() ?? "anvil";
  const port = await pickFreePort();
  const args = [
    "--port", String(port),
    "--host", "127.0.0.1",
    "--fork-url", opts.forkUrl,
    "--network", "base",
    "--retries", "8",
    "--timeout", "60000",
    "--no-fork-node-info",
    "--steps-tracing",
    ...(opts.forkBlockNumber !== undefined ? ["--fork-block-number", opts.forkBlockNumber.toString()] : []),
  ];
  const child = spawn(ANVIL_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  live.add(child);
  let output = "";
  const keep = (b: Buffer) => {
    output = (output + b.toString()).slice(-20_000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const url = `http://127.0.0.1:${port}`;

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      live.delete(child);
      return;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      child.kill("SIGTERM");
    });
    live.delete(child);
  };

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) {
      live.delete(child);
      throw new Error(`anvil exited with code ${child.exitCode}: ${redact(output, [opts.forkUrl]).slice(-2000)}`);
    }
    try {
      const id = await rpc(url, "eth_chainId");
      if (typeof id === "string") break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`anvil did not answer within 120 s: ${redact(output, [opts.forkUrl]).slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  opts.log(`[proof] ${version} listening on ${url} (fork of Base Sepolia via BASE_SEPOLIA_RPC_URL, not printed)`);
  return { url, port, version, stop };
}
