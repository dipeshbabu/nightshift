import { join } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { buildXdgEnv, buildUvEnv, buildPath } from "../../lib/env";
import { waitForServer } from "../../lib/server";
import { bootPrompt } from "../../lib/prompts/boot/boot";
import type { BootEvalStruct } from "../../lib/eval/types";
import { ensureApiKey } from "../../lib/eval/auth";
import { gradeFile } from "../../lib/eval/grader";
import {
  installEvalEnvironment,
  generateEvalOpencodeConfig,
} from "../../lib/eval/environment";

export type { FileResult, BootEvalResult } from "../../lib/eval/types";

export async function bootEval(
  pathToTestFile: string,
): Promise<import("../../lib/eval/types").BootEvalResult> {
  debugger;
  // Read test struct and BOOT.md content
  const testStruct = (await Bun.file(pathToTestFile).json()) as BootEvalStruct;
  const bootMdContent = await Bun.file(testStruct.inputPath).text();
  const prompt = bootPrompt(bootMdContent);

  // Check for API key before starting (prompts user if needed)
  const authInfo = await ensureApiKey(testStruct.model);

  // Create temp directories
  const tempBase = `/tmp/booteval-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const prefix = join(tempBase, "prefix");
  const workspace = join(tempBase, "workspace");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  let serverProc: ReturnType<typeof Bun.spawn> | null = null;

  try {
    // Install tools into temp prefix
    console.log("Installing eval environment...");
    await installEvalEnvironment(prefix);

    // Write opencode.json to workspace
    await Bun.write(
      join(workspace, "opencode.json"),
      generateEvalOpencodeConfig(testStruct.model),
    );

    // Start opencode server
    const port = 4096 + Math.floor(Math.random() * 1000);
    const serverUrl = `http://127.0.0.1:${port}`;
    const xdgEnv = buildXdgEnv(prefix);
    const opencodePath = join(prefix, "bin", "opencode");

    console.log(`Starting opencode server on port ${port}...`);
    serverProc = Bun.spawn([opencodePath, "serve", "--port", String(port)], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...xdgEnv,
        ...buildUvEnv(prefix),
        PATH: buildPath(prefix),
      },
    });

    // Wait for server
    await waitForServer(serverUrl);
    console.log("Server ready, starting eval...");

    // Create client and session
    const client = createOpencodeClient({ baseUrl: serverUrl });

    // Authenticate with API key if provided
    if (authInfo) {
      console.log(`Authenticating with ${authInfo.providerId}...`);
      await client.auth.set({
        providerID: authInfo.providerId,
        auth: { type: "api", key: authInfo.apiKey },
      });
      await client.instance.dispose();
      console.log("Authentication complete.");
    }

    const session = await client.session.create({ title: "Boot Eval" });
    if (!session.data) {
      throw new Error("Failed to create session");
    }
    const sessionId = session.data.id;

    // Set up event listener for completion
    const abort = new AbortController();
    const toolStates = new Map<string, string>();

    const sessionComplete = new Promise<void>((resolve, reject) => {
      (async () => {
        try {
          const events = await client.event.subscribe(
            {},
            { signal: abort.signal },
          );
          for await (const event of events.stream) {
            // Only process events for our session
            const eventSessionId =
              event.properties?.sessionID ??
              (event.properties as any)?.sessionID;
            if (eventSessionId && eventSessionId !== sessionId) continue;

            // Log text streaming
            if (event.type === "message.part.updated") {
              const { part, delta } = event.properties;
              if (part.type === "text" && delta) {
                process.stdout.write(delta);
              }
              // Log tool status changes
              if (part.type === "tool") {
                const prevState = toolStates.get(part.id);
                const currentState = part.state.status;
                if (prevState !== currentState) {
                  toolStates.set(part.id, currentState);
                  const title = (part.state as any).title || part.tool;
                  if (currentState === "running") {
                    console.log(`\n[Tool] Running: ${title}`);
                  } else if (currentState === "completed") {
                    console.log(`[Tool] Completed: ${title}`);
                  } else if (currentState === "error") {
                    const error = (part.state as any).error || "Unknown error";
                    console.log(`[Tool] Error: ${title} - ${error}`);
                  }
                }
              }
            }

            // Log permission requests (auto-approve for eval)
            if (event.type === "permission.asked") {
              const req = event.properties;
              console.log(`\n[Permission] Auto-approving: ${req.permission}`);
              await client.permission.reply({
                requestID: req.id,
                reply: "once",
              });
            }

            // Session completed
            if (
              event.type === "session.idle" &&
              event.properties.sessionID === sessionId
            ) {
              console.log("\n[Session] Idle - completed");
              resolve();
              return;
            }

            // Session error
            if (
              event.type === "session.error" &&
              (event.properties as any).sessionID === sessionId
            ) {
              console.log(
                `\n[Session] Error: ${JSON.stringify(event.properties)}`,
              );
              reject(
                new Error(`Session error: ${JSON.stringify(event.properties)}`),
              );
              return;
            }
          }
        } catch (err) {
          if (!abort.signal.aborted) reject(err);
        }
      })();
    });

    // Send prompt
    await client.session.promptAsync({
      sessionID: sessionId,
      parts: [{ type: "text", text: prompt }],
    });

    // Wait with timeout
    const timeout = new Promise<void>((_, reject) => {
      setTimeout(
        () => reject(new Error("Boot eval timed out after 10 minutes")),
        10 * 60 * 1000,
      );
    });
    await Promise.race([sessionComplete, timeout]);
    abort.abort();

    // Collect output files
    const files: import("../../lib/eval/types").FileResult[] = [];

    for (const skillPath of testStruct.output.skillsPaths) {
      const fullPath = join(workspace, skillPath);
      const found = existsSync(fullPath);
      if (found) {
        const content = await Bun.file(fullPath).text();
        files.push({ file: skillPath, type: "skill", found: true, content });
      } else {
        files.push({
          file: skillPath,
          type: "skill",
          found: false,
          content: null,
        });
      }
    }

    const agentsMdFullPath = join(workspace, testStruct.output.agentsMdPath);
    const agentsMdFound = existsSync(agentsMdFullPath);
    if (agentsMdFound) {
      const content = await Bun.file(agentsMdFullPath).text();
      files.push({
        file: testStruct.output.agentsMdPath,
        type: "agentsMd",
        found: true,
        content,
      });
    } else {
      files.push({
        file: testStruct.output.agentsMdPath,
        type: "agentsMd",
        found: false,
        content: null,
      });
    }

    // LLM-as-judge grading phase
    console.log("Starting LLM grading phase...");
    for (const fileResult of files) {
      if (!fileResult.found) {
        fileResult.llmScores = { D1: 0, D2: 0, D3: 0, D4: 0, D5: 0, total: 0 };
        console.log(`File not found: ${fileResult.file} - all scores set to 0`);
      } else {
        console.log(`Grading: ${fileResult.file}...`);
        fileResult.llmScores = await gradeFile(fileResult);
        console.log(
          `Graded ${fileResult.file}: total=${fileResult.llmScores.total}`,
        );
      }
    }

    console.log("Boot eval complete.");
    console.log(`=== RESULTS ===`);
    for (const fileResult of files) {
      console.log(
        `File: ${fileResult.file}, Found: ${fileResult.found}, Score: ${fileResult.llmScores?.total ?? "N/A"}`,
      );
    }
    return { files };
  } finally {
    // Cleanup
    if (serverProc) serverProc.kill();
    rmSync(tempBase, { recursive: true, force: true });
  }
}
