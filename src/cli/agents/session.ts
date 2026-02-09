import type { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { EventPublisher } from "./bus";

export interface SessionOptions {
  client: ReturnType<typeof createOpencodeClient>;
  prompt: string;
  title: string;
  model: string; // "provider/model" format
  phase?: "executor" | "validator" | "resolver";
  logPath?: string;
  timeoutMs?: number; // default 30min
  onText?: (text: string) => void;
  onToolStatus?: (tool: string, status: string, detail?: string) => void;
  bus?: EventPublisher;
}

export interface SessionResult {
  output: string;
  sessionId: string;
}

export function parseModel(model: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = model.split("/");
  return { providerID, modelID: rest.join("/") };
}

export async function getCommitHash(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--short=6", "HEAD"], { cwd, stdout: "pipe" });
  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

export async function runSession(options: SessionOptions): Promise<SessionResult> {
  const { client, prompt, title, model, phase, logPath, timeoutMs = 30 * 60 * 1000, onText, onToolStatus, bus } = options;

  const sessionTitle = phase ? `[${phase}] ${title}` : title;
  const session = await client.session.create({ title: sessionTitle });
  if (!session.data) throw new Error(`Failed to create session: ${title}`);
  const sessionId = session.data.id;

  const abort = new AbortController();
  let output = "";
  const toolStates = new Map<string, string>();
  const logWriter = logPath ? Bun.file(logPath).writer() : null;

  const appendLog = (msg: string) => {
    output += msg;
    if (logWriter) {
      logWriter.write(msg);
      logWriter.flush();
    }
  };

  const appendConsole = (msg: string) => {
    process.stdout.write(msg);
    appendLog(msg);
  };

  // If bus is present, publish structured events + log only. Otherwise write to stdout.
  const append = bus ? appendLog : appendConsole;

  const sessionComplete = new Promise<void>((resolve, reject) => {
    (async () => {
      try {
        const events = await client.event.subscribe({}, { signal: abort.signal });
        for await (const event of events.stream) {
          // Auto-approve permissions for our session
          if (event.type === "permission.asked") {
            const request = event.properties;
            if (request.sessionID === sessionId) {
              const desc = (request.metadata?.description as string) || (request.metadata?.filepath as string) || request.patterns?.[0] || "";
              if (bus && phase) {
                bus.publish({
                  type: "session.permission",
                  timestamp: Date.now(),
                  phase,
                  permission: request.permission,
                  description: desc,
                });
              }
              append(`[Auto-approving ${request.permission}${desc ? `: ${desc}` : ""}]\n`);
              await client.permission.reply({ requestID: request.id, reply: "once" });
            }
          }

          if (event.type === "message.part.updated") {
            const { part, delta } = event.properties;
            if (part.sessionID !== sessionId) continue;

            if (part.type === "text" && delta) {
              if (bus && phase) {
                bus.publish({
                  type: "session.text.delta",
                  timestamp: Date.now(),
                  phase,
                  delta,
                });
              }
              append(delta);
              onText?.(delta);
            }

            if (part.type === "tool") {
              const prevState = toolStates.get(part.id);
              const currentState = part.state.status;
              if (prevState !== currentState) {
                toolStates.set(part.id, currentState);
                const toolTitle = (part.state as any).title || part.tool;

                if (currentState === "running") {
                  const state = part.state as any;
                  if (bus && phase) {
                    bus.publish({
                      type: "session.tool.status",
                      timestamp: Date.now(),
                      phase,
                      tool: part.tool,
                      status: "running",
                      detail: toolTitle,
                      input: state.input,
                    });
                  }
                  let msg = `\n▶ ${toolTitle}`;
                  if (state.input) {
                    msg += ` ${JSON.stringify(state.input)}`;
                  }
                  msg += "\n";
                  append(msg);
                  onToolStatus?.(part.tool, "running", toolTitle);
                } else if (currentState === "completed") {
                  const state = part.state as any;
                  const duration = state.time?.start && state.time?.end
                    ? (state.time.end - state.time.start) / 1000
                    : undefined;
                  if (bus && phase) {
                    bus.publish({
                      type: "session.tool.status",
                      timestamp: Date.now(),
                      phase,
                      tool: part.tool,
                      status: "completed",
                      detail: toolTitle,
                      output: state.output?.trim(),
                      duration,
                      metadata: state.metadata,
                    });
                  }
                  let msg = `✓ ${toolTitle}`;
                  if (duration !== undefined) {
                    msg += ` (${duration.toFixed(1)}s)`;
                  }
                  msg += "\n";
                  if (state.output?.trim()) {
                    msg += state.output.trim() + "\n";
                  }
                  append(msg);
                  onToolStatus?.(part.tool, "completed", toolTitle);
                } else if (currentState === "error") {
                  const state = part.state as any;
                  const error = state.error || "Unknown error";
                  const duration = state.time?.start && state.time?.end
                    ? (state.time.end - state.time.start) / 1000
                    : undefined;
                  if (bus && phase) {
                    bus.publish({
                      type: "session.tool.status",
                      timestamp: Date.now(),
                      phase,
                      tool: part.tool,
                      status: "error",
                      detail: error,
                      input: state.input,
                      duration,
                    });
                  }
                  let msg = `✗ ${toolTitle}: ${error}`;
                  if (state.input) {
                    msg += `\n  input: ${JSON.stringify(state.input)}`;
                  }
                  if (duration !== undefined) {
                    msg += `\n  duration: ${duration.toFixed(1)}s`;
                  }
                  msg += "\n";
                  append(msg);
                  onToolStatus?.(part.tool, "error", error);
                }
              }
            }
          }

          if (event.type === "session.idle" && event.properties.sessionID === sessionId) {
            resolve();
            return;
          }
          if (event.type === "session.error" && (event.properties as any).sessionID === sessionId) {
            reject(new Error(`Session error: ${JSON.stringify(event.properties)}`));
            return;
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) reject(err);
      }
    })();
  });

  const { providerID, modelID } = parseModel(model);

  await client.session.promptAsync({
    sessionID: sessionId,
    model: { providerID, modelID },
    parts: [{ type: "text", text: prompt }],
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Session "${title}" timed out`)), timeoutMs),
  );
  await Promise.race([sessionComplete, timeout]);
  abort.abort();
  logWriter?.end();

  return { output, sessionId };
}
