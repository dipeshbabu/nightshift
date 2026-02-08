import type { createOpencodeClient } from "@opencode-ai/sdk/v2";

export interface SessionOptions {
  client: ReturnType<typeof createOpencodeClient>;
  prompt: string;
  title: string;
  model: string; // "provider/model" format
  phase?: "executor" | "validator";
  logPath?: string;
  timeoutMs?: number; // default 30min
  onText?: (text: string) => void;
  onToolStatus?: (tool: string, status: string, detail?: string) => void;
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
  const { client, prompt, title, model, phase, logPath, timeoutMs = 30 * 60 * 1000, onText, onToolStatus } = options;

  const sessionTitle = phase ? `[${phase}] ${title}` : title;
  const session = await client.session.create({ title: sessionTitle });
  if (!session.data) throw new Error(`Failed to create session: ${title}`);
  const sessionId = session.data.id;

  const abort = new AbortController();
  let output = "";
  const toolStates = new Map<string, string>();
  const logWriter = logPath ? Bun.file(logPath).writer() : null;

  const append = (msg: string) => {
    process.stdout.write(msg);
    output += msg;
    if (logWriter) {
      logWriter.write(msg);
      logWriter.flush();
    }
  };

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
              append(`[Auto-approving ${request.permission}${desc ? `: ${desc}` : ""}]\n`);
              await client.permission.reply({ requestID: request.id, reply: "once" });
            }
          }

          if (event.type === "message.part.updated") {
            const { part, delta } = event.properties;
            if (part.sessionID !== sessionId) continue;

            if (part.type === "text" && delta) {
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
                  append(`\n▶ ${toolTitle}\n`);
                  onToolStatus?.(part.tool, "running", toolTitle);
                } else if (currentState === "completed") {
                  const state = part.state as any;
                  let msg = `✓ ${toolTitle}\n`;
                  if (state.output?.trim()) {
                    msg += state.output.trim() + "\n";
                  }
                  append(msg);
                  onToolStatus?.(part.tool, "completed", toolTitle);
                } else if (currentState === "error") {
                  const error = (part.state as any).error || "Unknown error";
                  append(`✗ ${toolTitle}: ${error}\n`);
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
