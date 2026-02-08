import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { join } from "path";
import { mkdirSync, unlinkSync } from "fs";
import { buildXdgEnv, buildUvEnv, buildPath } from "../../lib/env";
import { waitForServer } from "../../lib/server";
import { buildSandboxCommand } from "../../lib/sandbox";
import type { Subprocess } from "bun";

export interface ServerHandle {
  proc: Subprocess | null;
  client: ReturnType<typeof createOpencodeClient>;
  serverUrl: string;
  name: string;
  kill: () => void;
}

interface PidInfo {
  pid: number;
  port: number;
}

function pidFilePath(prefix: string, name: string): string {
  return join(prefix, "run", `${name}.json`);
}

function writePidFile(prefix: string, name: string, info: PidInfo): void {
  const dir = join(prefix, "run");
  mkdirSync(dir, { recursive: true });
  Bun.write(pidFilePath(prefix, name), JSON.stringify(info));
}

function removePidFile(prefix: string, name: string): void {
  try { unlinkSync(pidFilePath(prefix, name)); } catch { }
}

async function readPidFile(prefix: string, name: string): Promise<PidInfo | null> {
  try {
    const file = Bun.file(pidFilePath(prefix, name));
    if (!(await file.exists())) return null;
    return JSON.parse(await file.text()) as PidInfo;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isServerHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startAgentServer(opts: {
  prefix: string;
  workspace: string;
  port?: number;
  name?: string;
}): Promise<ServerHandle> {
  const { prefix, workspace, name = "nightshift-ralph" } = opts;

  // Try to reuse an existing server for this name
  const existing = await readPidFile(prefix, name);
  if (existing && isProcessAlive(existing.pid)) {
    const existingUrl = `http://127.0.0.1:${existing.port}`;
    if (await isServerHealthy(existingUrl)) {
      console.log(`[ralph] Reusing existing ${name} server (pid ${existing.pid}, port ${existing.port})`);
      const client = createOpencodeClient({ baseUrl: existingUrl });
      return {
        proc: null,
        client,
        serverUrl: existingUrl,
        name,
        kill: () => {
          try { process.kill(existing.pid); } catch { }
          removePidFile(prefix, name);
        },
      };
    }
    // Stale process, kill it
    console.log(`[ralph] Cleaning up stale ${name} process (pid ${existing.pid})`);
    try { process.kill(existing.pid); } catch { }
    removePidFile(prefix, name);
  }

  // Start a fresh server
  const port = opts.port ?? 4096 + Math.floor(Math.random() * 1000);
  const serverUrl = `http://127.0.0.1:${port}`;
  const opencodePath = join(prefix, "bin", "opencode");

  const env = {
    ...process.env,
    ...buildXdgEnv(prefix),
    ...buildUvEnv(prefix),
    PATH: buildPath(prefix),
    NIGHTSHIFT_PROCESS_NAME: name,
  };

  const cmd = buildSandboxCommand(
    [opencodePath, "serve", "--port", String(port)],
    { workspacePath: workspace, prefixPath: prefix, binDir: join(prefix, "bin"), env },
  );

  const proc = Bun.spawn(cmd, {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  await waitForServer(serverUrl);
  writePidFile(prefix, name, { pid: proc.pid, port });
  const client = createOpencodeClient({ baseUrl: serverUrl });

  return {
    proc,
    client,
    serverUrl,
    name,
    kill: () => {
      proc.kill();
      removePidFile(prefix, name);
    },
  };
}
