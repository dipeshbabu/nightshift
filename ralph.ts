import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { mkdirSync, existsSync, cpSync } from "fs";
import { join, resolve } from "path";
import { buildXdgEnv, buildUvEnv, buildPath } from "./src/lib/env";
import { waitForServer } from "./src/lib/server";
import { buildSandboxCommand } from "./src/lib/sandbox";

const PROMPT_FILE = "PROMPT.txt";
const LOG_DIR = "agent_logs";
const AGENT_MODEL = "openai/gpt-5.2-codex";
const EVAL_MODEL = "openai/gpt-5.2-codex";


async function getCommitHash(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--short=6", "HEAD"], { cwd, stdout: "pipe" });
  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

async function readFileIfExists(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : null;
}


async function startServer(prefix: string, workspace: string) {
  const port = 4096 + Math.floor(Math.random() * 1000);
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
  return { proc, client, serverUrl };
}

function log(msg: string) {
  process.stdout.write(msg);
}

async function runSession(
  client: ReturnType<typeof createOpencodeClient>,
  prompt: string,
  title: string,
  model: string,
  logPath: string,
): Promise<string> {
  const session = await client.session.create({ title });
  if (!session.data) throw new Error(`Failed to create session: ${title}`);
  const sessionId = session.data.id;

  const abort = new AbortController();
  let output = "";
  const toolStates = new Map<string, string>();
  const logWriter = Bun.file(logPath).writer();

  const append = (msg: string) => {
    log(msg);
    output += msg;
    logWriter.write(msg);
    logWriter.flush();
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
            }

            if (part.type === "tool") {
              const prevState = toolStates.get(part.id);
              const currentState = part.state.status;
              if (prevState !== currentState) {
                toolStates.set(part.id, currentState);
                const toolTitle = (part.state as any).title || part.tool;

                if (currentState === "running") {
                  append(`\n▶ ${toolTitle}\n`);
                } else if (currentState === "completed") {
                  const state = part.state as any;
                  let msg = `✓ ${toolTitle}\n`;
                  if (state.output?.trim()) {
                    msg += state.output.trim() + "\n";
                  }
                  append(msg);
                } else if (currentState === "error") {
                  const error = (part.state as any).error || "Unknown error";
                  append(`✗ ${toolTitle}: ${error}\n`);
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

  // Parse model string "provider/model"
  const [providerID, ...rest] = model.split("/");
  const modelID = rest.join("/");

  await client.session.promptAsync({
    sessionID: sessionId,
    model: { providerID, modelID },
    parts: [{ type: "text", text: prompt }],
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Session "${title}" timed out`)), 30 * 60 * 1000),
  );
  await Promise.race([sessionComplete, timeout]);
  abort.abort();
  logWriter.end();

  return output;
}

async function loop() {
  const homePrefix = join(process.env.HOME!, ".nightshift");
  if (!existsSync(join(homePrefix, "bin", "opencode"))) {
    console.error("[ralph] opencode not found at ~/.nightshift/bin/opencode — run `nightshift install` first");
    process.exit(1);
  }

  // Create isolated workspace
  const workspace = resolve(`ralph_workspace_${Date.now()}`);
  mkdirSync(workspace, { recursive: true });

  const logDir = join(workspace, LOG_DIR);
  mkdirSync(logDir, { recursive: true });

  // Init git repo with an initial commit so rev-parse HEAD works
  await Bun.spawn(["git", "init"], { cwd: workspace, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "commit", "--allow-empty", "-m", "initial"], { cwd: workspace, stdout: "pipe", stderr: "pipe" }).exited;

  // Copy prompt into workspace
  cpSync(PROMPT_FILE, join(workspace, PROMPT_FILE));

  // All permissions auto-approved
  await Bun.write(join(workspace, "opencode.json"), JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    model: AGENT_MODEL,
    permission: {
      edit: "allow", bash: "allow", webfetch: "allow", write: "allow",
      codesearch: "allow", read: "allow", grep: "allow", glob: "allow",
      list: "allow", lsp: "allow", skill: "allow", todowrite: "allow",
      todoread: "allow", question: "allow",
    },
  }, null, 2));

  // Resolve API key
  const provider = AGENT_MODEL.split("/")[0];
  const apiKey = provider === "openai"
    ? process.env.OPENAI_API_KEY
    : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(`[ralph] Missing ${provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} in environment`);
    process.exit(1);
  }

  console.log(`[ralph] Workspace: ${workspace}`);
  console.log("[ralph] Starting sandboxed opencode server...");
  const { proc: serverProc, client } = await startServer(homePrefix, workspace);

  // Authenticate with the provider
  console.log(`[ralph] Authenticating with ${provider}...`);
  await client.auth.set({
    providerID: provider,
    auth: { type: "api", key: apiKey },
  });
  await client.instance.dispose();

  const basePrompt = await Bun.file(PROMPT_FILE).text();

  try {
    while (true) {
      const commit = await getCommitHash(workspace);
      const agentLog = join(logDir, `agent_${commit}.log`);
      const evalLog = join(logDir, `evaluator_${commit}.log`);

      // Build agent prompt with context from previous runs
      let prompt = basePrompt;

      const prevAgentOutput = await readFileIfExists(agentLog);
      const prevEvalOutput = await readFileIfExists(evalLog);

      if (prevAgentOutput) {
        prompt += `\n\nTHIS IS WHAT HAPPENED LAST RUN:\n${prevAgentOutput}`;
      }
      if (prevEvalOutput) {
        prompt += `\n\nEVALUATOR SAID YOU ARE NOT DONE WITH THIS MESSAGE:\n${prevEvalOutput}`;
      }

      // Exec phase
      console.log(`\n[ralph] ── Agent run on ${commit} ──`);
      const agentOutput = await runSession(client, prompt, `agent_${commit}`, AGENT_MODEL, agentLog);
      console.log(`\n[ralph] Agent log: ${agentLog}`);

      // Eval phase
      console.log(`[ralph] ── Evaluator on ${commit} ──`);
      const evalPrompt = [
        "You are an evaluator. The original task was:",
        "```",
        basePrompt,
        "```",
        "",
        "The agent produced this output:",
        "```",
        agentOutput,
        "```",
        "",
        "Thoughly explore and test the environment. You need to grade this CRITICALLY.",
        "You shouldn't only look at the agent output, but you should also test the code manually like you're performing UAT.",
        "Is the task DONE? If the task is fully complete, respond with exactly DONE on its own line.",
        "If NOT done, explain concisely what still needs to be completed.",
      ].join("\n");

      const evalOutput = await runSession(client, evalPrompt, `eval_${commit}`, EVAL_MODEL, evalLog);
      console.log(`\n[ralph] Evaluator log: ${evalLog}`);

      if (evalOutput.includes("DONE")) {
        console.log("[ralph] Evaluator says DONE. Exiting.");
        break;
      }

      console.log("[ralph] Not done yet. Looping...");
    }
  } finally {
    serverProc.kill();
  }

  process.exit(0);
}

loop();
