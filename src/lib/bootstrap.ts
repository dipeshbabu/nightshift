import type { ToolCompletionPart } from "./types";
import type { BootstrapUI } from "../bootstrap-prompt";

export function buildBootstrapPrompt(userIntent: string): string {
  return `
You are bootstrapping a new workspace for the user. Their stated purpose is:
"${userIntent}"

## Important: Interview the User

If asked to read from a BOOT.md file, you must read it first. There will be information useful for you to help the user.

If there is a mention of Skills in either Markdown or JSON in the BOOT.md, you MUST use those to create skill files in your current working directory in the path .opencode/skills/<name>/SKILL.md.


Before taking any action outside of reading the BOOT.md, interview the user extensively to understand their needs:
- What specific problems are they trying to solve?
- What data sources will they work with?
- What are their preferred tools or libraries?
- What is their experience level with Python?
- Any specific requirements or constraints?

Use the AskUserQuestion tool to gather this information. Ask 2-4 focused questions before proceeding.

## After gathering information:

1. **TODO project tracker**: You need to set up a TODO for this bootstrapping task so you don't forget any steps. Validate by reading back the TODOs and the environment.
1. **Install packages**: Run \`uv add <packages>\` to install Python libraries appropriate for this use case
2. **Create library structure**: Add modules to src/agent_lib/ that will help with the stated purpose
3. **Generate SKILLS.md for each skill needed**: Create a SKILL.md at .opencode/skills/<name>/SKILL.md file with the SKILL.
3. **Generate AGENTS.md**: Create an AGENTS.md file following these best practices:

## SKILLS.md Guidelines:

You should always look up best practices for creating SKILLs.md files online before generating one. An extensive web search is recommended.

## AGENTS.md Guidelines:

You should always look up best practices for creating AGENTS.md files online before generating one. An extensive web search is recommended.

### Required Sections:
- **Project Overview**: One-sentence description tailored to "${userIntent}"
- **Commands**: Exact commands for build, test, run (use bun, uv, pytest)
- **Tech Stack**: Python 3.13, Bun, uv, and installed packages
- **Project Structure**: Key file paths and their purposes
- **Code Style**: Formatting rules, design patterns (use ruff, black)
- **Do's and Don'ts**: Specific, actionable guidelines for this use case
- **Safety Boundaries**:
  - Always do: Read files, run tests, format code
  - Ask first: Install new packages, modify pyproject.toml
  - Never do: Delete data, run destructive commands

### Style Guidelines:
- Be specific, not vague
- Use code examples, not descriptions
- Make commands copy-pasteable
- Prioritize capabilities over file structure
`.trim();
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
