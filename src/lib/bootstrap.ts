import type { ToolCompletionPart } from "./types";
import type { BootstrapUI } from "../tui/routines/bootstrap";
import { bootPrompt } from "./prompts/boot/boot";

export function buildBootstrapPrompt(userIntent: string): string {
  return bootPrompt(userIntent);
}


export function handleToolCompletion(
  ui: BootstrapUI,
  part: ToolCompletionPart,
): void {
  const { state, tool } = part;
  const output = state.output;
  const input = state.input;
  const metadata = state.metadata;
  const title = state.title || tool;

  if (tool === "bash" && output?.trim()) {
    const command = (input?.command as string) || title;
    const description = input?.description as string | undefined;
    ui.showBashOutput(command, output, description);
  } else if (tool === "write" && input?.filePath) {
    ui.showWriteOutput(input.filePath as string, (input.content as string) || "");
  } else if (tool === "edit" && metadata?.diff && input?.filePath) {
    // edit tool: single file, filePath in input
    ui.showEditOutput(input.filePath as string, metadata.diff as string);
  } else if (tool === "apply_patch" && metadata?.diff) {
    // apply_patch: multiple files, extract paths from metadata.files or use title
    const files = metadata.files as Array<{ filePath?: string; relativePath?: string }> | undefined;
    const filePath = files?.map(f => f.relativePath || f.filePath).join(", ") || title;
    ui.showEditOutput(filePath, metadata.diff as string);
  } else {
    ui.appendToolStatus("completed", title);
  }
}

export async function autoApprovePermission(
  client: import("@opencode-ai/sdk/v2").OpencodeClient,
  ui: BootstrapUI,
  request: { id: string; permission: string; metadata?: Record<string, unknown>; patterns?: string[] },
): Promise<void> {
  const description = (request.metadata?.description as string) || (request.metadata?.filepath as string) || request.patterns?.[0] || "";
  ui.appendText(`[Auto-approving ${request.permission}${description ? `: ${description}` : ""}]\n`);
  await client.permission.reply({ requestID: request.id, reply: "once" });
}

export async function bootstrapWithOpencode(
  prefix: string,
  workspacePath: string,
  userIntent: string,
  xdgEnv: Record<string, string>,
  ui: BootstrapUI,
  client: import("@opencode-ai/sdk/v2").OpencodeClient,
  url: string,
  model?: { providerID: string; modelID: string },
): Promise<void> {
  ui.setStatus("Sending bootstrap prompt...");

  const abort = new AbortController();

  try {

    // Create session
    const session = await client.session.create({ title: "Bootstrap" });
    if (!session.data) {
      throw new Error("Failed to create session");
    }
    const sessionId = session.data.id;

    // Track tool states to avoid duplicate output
    const toolStates = new Map<string, string>();

    // Set up event handling for permissions and streaming output
    const sessionComplete = new Promise<void>((resolve, reject) => {
      (async () => {
        try {
          const events = await client.event.subscribe({}, { signal: abort.signal });

          for await (const event of events.stream) {
            // Auto-approve all permission requests during bootstrap
            // TODO: we should not do this
            if (event.type === "permission.asked") {
              const request = event.properties;
              if (request.sessionID === sessionId) {
                await autoApprovePermission(client, ui, request);
              }
            }

            // Stream text output
            if (event.type === "message.part.updated") {
              const { part, delta } = event.properties;
              if (part.sessionID !== sessionId) continue;

              // Stream text deltas
              if (part.type === "text" && delta) {
                ui.appendText(delta);
              }

              // Show tool execution status
              if (part.type === "tool") {
                const prevState = toolStates.get(part.id);
                const currentState = part.state.status;

                if (prevState !== currentState) {
                  toolStates.set(part.id, currentState);
                  const title = (part.state as any).title || part.tool;

                  if (currentState === "running") {
                    ui.setStatus(`Running: ${title}`);
                    ui.appendToolStatus("running", title);
                  } else if (currentState === "completed") {
                    handleToolCompletion(ui, {
                      tool: part.tool,
                      state: part.state as ToolCompletionPart["state"],
                      id: part.id,
                    });
                  } else if (currentState === "error") {
                    const error = (part.state as any).error || "Unknown error";
                    ui.appendToolStatus("error", `${title}: ${error}`);
                  }
                }
              }
            }

            // Handle session diffs (file changes)
            if (event.type === "session.diff") {
              const { sessionID, diff } = event.properties;
              if (sessionID === sessionId && diff && diff.length > 0) {
                ui.showDiff(diff);
              }
            }

            // Handle question events
            if (event.type === "question.asked") {
              const request = event.properties;
              if (request.sessionID === sessionId) {
                try {
                  const answers = await ui.showQuestion(request);
                  await client.question.reply({
                    requestID: request.id,
                    answers,
                  });
                } catch (err) {
                  // User rejected/cancelled the question
                  await client.question.reject({
                    requestID: request.id,
                  });
                }
              }
            }

            // Check if session is idle (completed)
            if (event.type === "session.idle" && event.properties.sessionID === sessionId) {
              resolve();
              return;
            }

            // Handle session errors
            if (event.type === "session.error" && (event.properties as any).sessionID === sessionId) {
              reject(new Error(`Session error: ${JSON.stringify(event.properties)}`));
              return;
            }
          }
        } catch (err) {
          if (!abort.signal.aborted) {
            reject(err);
          }
        }
      })();
    });

    // Send bootstrap prompt asynchronously
    const prompt = buildBootstrapPrompt(userIntent);
    await client.session.promptAsync({
      sessionID: sessionId,
      model: model,
      parts: [{ type: "text", text: prompt }],
    });

    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Bootstrap timed out after 5 minutes")), 5 * 60 * 1000);
    });

    // Wait for session to complete...timeout after 5 minutes
    await Promise.race([sessionComplete, timeout]);

    ui.setStatus("Bootstrap complete!");
  } finally {
    abort.abort();
  }
}
