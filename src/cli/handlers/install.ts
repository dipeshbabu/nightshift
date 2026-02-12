import { resolve, join } from "path";
import { mkdirSync, existsSync } from "fs";
import { detectPlatform } from "../../lib/platform";
import { saveActivePrefix } from "../../lib/config";
import { uvUrl, ripgrepUrl, opencodeUrl, installTool, installUvTools, installRubyAndGollum } from "../../lib/tools";
import { createWorkspaceScaffold, syncWorkspace } from "../../lib/workspace";
import { WORKSPACE_PACKAGES, XDG_DIRS, AGENT_LIBRARY_NAME, WORKSPACE_DIRNAME } from "../../lib/constants";
//import { bootstrapWithOpencode } from "../../lib/bootstrap";
//import { readFullConfig, expandHome } from "../../lib/config";
//import { buildXdgEnv } from "../../lib/env";
//

export async function createWorkspace(prefix: string): Promise<void> {
  try {
    const workspacePath = join(prefix, WORKSPACE_DIRNAME);
    const libraryName = AGENT_LIBRARY_NAME;
    const packages = WORKSPACE_PACKAGES;
    // Create XDG directories for isolated opencode config/data/cache/state
    for (const dir of XDG_DIRS) {
      mkdirSync(join(prefix, dir), { recursive: true });
    }
    //const xdgEnv = buildXdgEnv(prefix);
    //const isNewWorkspace = !existsSync(workspacePath);
    //create the workspace scaffold
    await createWorkspaceScaffold(workspacePath, libraryName, packages, { skipAgentsMd: true });
    // syncing the workspace this is what downloads the python dependencies and sets up the venv. leverages uv
    await syncWorkspace(prefix, workspacePath);

    // Write opencode.json with all permissions auto-approved
    await Bun.write(join(workspacePath, "opencode.json"), JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      permission: {
        edit: "allow", bash: "allow", webfetch: "allow", write: "allow",
        codesearch: "allow", read: "allow", grep: "allow", glob: "allow",
        list: "allow", lsp: "allow", skill: "allow", todowrite: "allow",
        todoread: "allow", question: "allow",
      },
    }, null, 2));

    // Init git repo and commit all scaffold files so they're tracked.
    // This prevents "untracked working tree files would be overwritten"
    // errors when merging task branches back into main.
    await Bun.spawn(["git", "init"], { cwd: workspacePath, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "add", "-A"], { cwd: workspacePath, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: workspacePath, stdout: "pipe", stderr: "pipe" }).exited;

    // Save active prefix for future runs
    await saveActivePrefix(prefix);
  } catch (err) {
    console.error("Failed to create workspace:", err);
    process.exit(1);
  }
}

export async function installTools(prefix: string): Promise<void> {
  try {
    prefix = resolve(prefix);
    if (existsSync(prefix)) {
      console.error(`Error: Prefix directory already exists at ${prefix}`);
      process.exit(1);
    }

    console.log(`Installing nightshift tools to ${prefix}`);

    const platform = detectPlatform();
    console.log(`Detected platform: ${platform.os} / ${platform.arch}`);

    const uv = uvUrl(platform);
    await installTool("uv", uv.url, prefix, [
      { linkName: "uv", target: uv.extractedBinary },
    ]);

    const rg = ripgrepUrl(platform);
    await installTool("ripgrep", rg.url, prefix, [
      { linkName: "rg", target: rg.extractedBinary },
    ]);

    const oc = opencodeUrl(platform);
    await installTool("opencode", oc.url, prefix, [
      { linkName: "opencode", target: oc.extractedBinary },
    ]);

    await installUvTools(prefix);
    await installRubyAndGollum(prefix);

  } catch (err) {
    console.error("Failed to install tools:", err);
    process.exit(1);
  }
}
