/**
 * Gollum process manager — starts a read-only file viewer for the agent workspace.
 *
 * Follows the same PID-file pattern used by server.ts and run.ts.
 */
import { join, delimiter } from "path";
import { posixPath } from "../../lib/env";
import { mkdirSync, unlinkSync } from "fs";
import type { Subprocess } from "bun";

export interface GollumHandle {
  proc: Subprocess | null;
  port: number;
  url: string;
  kill: () => void;
}

interface GollumPidInfo {
  pid: number;
  port: number;
}

function pidFilePath(prefix: string): string {
  return join(prefix, "run", "gollum.json");
}

function writePidFile(prefix: string, info: GollumPidInfo): void {
  const dir = join(prefix, "run");
  mkdirSync(dir, { recursive: true });
  Bun.write(pidFilePath(prefix), JSON.stringify(info));
}

function removePidFile(prefix: string): void {
  try { unlinkSync(pidFilePath(prefix)); } catch { }
}

async function readPidFile(prefix: string): Promise<GollumPidInfo | null> {
  try {
    const file = Bun.file(pidFilePath(prefix));
    if (!(await file.exists())) return null;
    return JSON.parse(await file.text()) as GollumPidInfo;
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

export function generateGollumConfig(): string {
  return `# Gollum configuration for Nightshift workspace
Precious::App.set(:wiki_options, {
  index_page: 'README',
  h1_title: true,
  base_path: 'wiki',
})
`;
}

async function ensureGollumConfig(workspace: string): Promise<void> {
  const configPath = join(workspace, "gollum_config.rb");
  const file = Bun.file(configPath);
  if (await file.exists()) return;
  await Bun.write(configPath, generateGollumConfig());
}

export async function startGollumServer(opts: {
  prefix: string;
  workspace: string;
  port?: number;
  ref?: string;
}): Promise<GollumHandle> {
  const { prefix, workspace, ref = "main" } = opts;
  const port = opts.port ?? 3001;
  const url = `http://localhost:${port}`;

  // Try to reuse an existing server
  const existing = await readPidFile(prefix);
  if (existing && isProcessAlive(existing.pid)) {
    console.log(`[gollum] Reusing existing file viewer (pid ${existing.pid}, port ${existing.port})`);
    return {
      proc: null,
      port: existing.port,
      url: `http://localhost:${existing.port}`,
      kill: () => {
        try { process.kill(existing.pid); } catch { }
        removePidFile(prefix);
      },
    };
  }

  // Clean up stale PID file
  if (existing) {
    removePidFile(prefix);
  }

  // Ensure config exists in workspace
  await ensureGollumConfig(workspace);

  const configPath = join(workspace, "gollum_config.rb");
  const gollumBin = join(prefix, "bin", "gollum");
  const gemHome = join(prefix, "gems");
  const proc = Bun.spawn(
    [gollumBin, "--ref", ref, "--port", String(port), "--config", configPath, workspace],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GEM_HOME: posixPath(gemHome),
        PATH: `${posixPath(join(prefix, "bin"))}${delimiter}${process.env.PATH}`,
      },
    },
  );

  writePidFile(prefix, { pid: proc.pid, port });
  console.log(`[gollum] File viewer listening on ${url}`);

  return {
    proc,
    port,
    url,
    kill: () => {
      proc.kill();
      removePidFile(prefix);
    },
  };
}
