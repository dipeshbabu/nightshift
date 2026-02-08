import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { join } from "path";
import { buildXdgEnv, buildUvEnv, buildPath } from "../../lib/env";
import { waitForServer } from "../../lib/server";
import { buildSandboxCommand } from "../../lib/sandbox";
import type { Subprocess } from "bun";

export interface ServerHandle {
  proc: Subprocess;
  client: ReturnType<typeof createOpencodeClient>;
  serverUrl: string;
  kill: () => void;
}

export async function startAgentServer(opts: {
  prefix: string;
  workspace: string;
  port?: number;
}): Promise<ServerHandle> {
  const { prefix, workspace } = opts;
  const port = opts.port ?? 4096 + Math.floor(Math.random() * 1000);
  const serverUrl = `http://127.0.0.1:${port}`;
  const opencodePath = join(prefix, "bin", "opencode");

  const env = {
    ...process.env,
    ...buildXdgEnv(prefix),
    ...buildUvEnv(prefix),
    PATH: buildPath(prefix),
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
  const client = createOpencodeClient({ baseUrl: serverUrl });

  return {
    proc,
    client,
    serverUrl,
    kill: () => proc.kill(),
  };
}
