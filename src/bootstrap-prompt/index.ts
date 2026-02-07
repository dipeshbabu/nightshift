import { createCliRenderer } from "@opentui/core";
import { join } from "path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { buildPath } from "../lib/env";
import { waitForServer } from "../lib/server";
import type { BootstrapUI, BootstrapPromptOptions, BootstrapPromptResult, BootstrapState } from "./types";
import { createAllViews } from "./views";
import { createBootstrapUI } from "./ui";
import { createAuthHandlers } from "./auth";
import { setupEventHandlers } from "./events";

// Re-export public types
export type { FileDiff, BootstrapUI, BootstrapPromptOptions, BootstrapPromptResult } from "./types";
export type { QuestionRequest, QuestionAnswer } from "./types";

/**
 * Shows a TUI prompt for provider selection, model selection, and user intent.
 * @param onBootstrap - Called with the user's intent, UI interface, SDK client, server URL, and selected model
 * @param options - Configuration including prefix, workspacePath, and xdgEnv
 * @returns The user's intent string, or null if they skipped (Ctrl+C), along with the SDK client and selected model
 */
export async function runBootstrapPrompt(
  onBootstrap: (intent: string, ui: BootstrapUI, client: OpencodeClient, serverUrl: string, model: { providerID: string; modelID: string }) => Promise<void>,
  options: BootstrapPromptOptions
): Promise<BootstrapPromptResult | null> {
  const { renderer: customRenderer, skipTtyCheck = false, autoStart = true, prefix, workspacePath, xdgEnv } = options;

  // Check if we're in a TTY
  if (!skipTtyCheck && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.log("Not running in a TTY, skipping bootstrap prompt.");
    return null;
  }

  const renderer = customRenderer ?? await createCliRenderer({
    exitOnCtrlC: true,
  });

  // Start opencode server early
  const binDir = join(prefix, "bin");
  const opencodePath = join(binDir, "opencode");
  const port = 4096 + Math.floor(Math.random() * 1000);
  const serverUrl = `http://127.0.0.1:${port}`;

  const serverProc = Bun.spawn([opencodePath, "serve", "--port", String(port)], {
    cwd: workspacePath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...xdgEnv, PATH: buildPath(prefix) },
  });

  // Import SDK client
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
  let client: OpencodeClient;

  return new Promise<BootstrapPromptResult | null>(async (resolve, reject) => {
    const state: BootstrapState = {
      viewState: { type: "loading" },
      selectedModel: null,
      resolved: false,
      outputCounter: 0,
      oauthAbort: null,
      currentTextNode: null,
      currentTextContent: "",
    };

    // Helper to destroy renderer (skip for custom renderers used in testing)
    const destroyRenderer = () => {
      if (!customRenderer) renderer.destroy();
    };

    const cleanup = async (value: BootstrapPromptResult | null) => {
      if (state.resolved) return;
      state.resolved = true;
      destroyRenderer();
      if (!value) serverProc.kill();
      resolve(value);
    };

    const cleanupWithError = (err: unknown) => {
      if (state.resolved) return;
      state.resolved = true;
      destroyRenderer();
      serverProc.kill();
      reject(err);
    };

    // Create all views
    const views = createAllViews(renderer);
    renderer.root.add(views.container);

    // Create UI interface
    const ui = createBootstrapUI(renderer, views, state);

    // Create auth handlers
    const auth = createAuthHandlers(views, state);

    // Wire up event handlers
    setupEventHandlers({
      renderer,
      views,
      state,
      ui,
      auth,
      getClient: () => client,
      onBootstrap,
      serverUrl,
      xdgEnv,
      prefix,
      cleanup,
      cleanupWithError,
      serverProc,
    });

    // Start rendering (skip for testing when renderer is managed externally)
    if (autoStart) {
      renderer.start();
    }

    // Wait for server and show provider selection
    try {
      await waitForServer(serverUrl);
      client = createOpencodeClient({ baseUrl: serverUrl });
      auth.goToProviderSelect();
    } catch (err) {
      cleanupWithError(err);
    }
  });
}
