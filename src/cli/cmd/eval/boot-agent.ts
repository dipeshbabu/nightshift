import { join, relative } from "path";
import { mkdirSync, existsSync, rmSync, symlinkSync, chmodSync, unlinkSync } from "fs";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import {
  detectPlatform,
  pythonUrl,
  uvUrl,
  ripgrepUrl,
  opencodeUrl,
  buildXdgEnv,
  buildPath,
  waitForServer,
} from "../../../index";

type BootEvalStruct = {
  inputPath: string;
  model?: string;
  output: {
    skillsPaths: Array<string>;
    agentsMdPath: string;
  }
}

export type FileResult = {
  file: string;
  found: boolean;
  content: string | null;
}

export type BootEvalResult = {
  files: FileResult[];
  fullContent: string;
}

type ProviderConfig = {
  name: string;
  envVar: string;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  anthropic: { name: "Anthropic", envVar: "ANTHROPIC_API_KEY" },
  openai: { name: "OpenAI", envVar: "OPENAI_API_KEY" },
};

function detectProvider(model: string): ProviderConfig | null {
  const provider = model.split("/")[0]?.toLowerCase();
  return PROVIDER_CONFIGS[provider] ?? null;
}

async function promptForApiKey(provider: ProviderConfig): Promise<string> {
  process.stdout.write(`Enter your ${provider.name} API key: `);

  return new Promise((resolve) => {
    let input = "";
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (char: string) => {
      if (char === "\n" || char === "\r") {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
      } else if (char === "\u0003") {
        // Ctrl+C
        process.exit(1);
      } else if (char === "\u007f") {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        input += char;
        process.stdout.write("*");
      }
    };

    process.stdin.on("data", onData);
  });
}

type ApiKeyResult = {
  providerId: string;
  apiKey: string;
} | null;

async function ensureApiKey(model?: string): Promise<ApiKeyResult> {
  if (!model) return null;

  const provider = detectProvider(model);
  if (!provider) return null;

  const providerId = model.split("/")[0].toLowerCase();

  const existingKey = process.env[provider.envVar];
  if (existingKey) {
    console.log(`Using ${provider.name} API key from ${provider.envVar}`);
    return { providerId, apiKey: existingKey };
  }

  console.log(`No ${provider.envVar} found in environment.`);
  const apiKey = await promptForApiKey(provider);

  if (!apiKey.trim()) {
    throw new Error(`${provider.name} API key is required for model: ${model}`);
  }

  return { providerId, apiKey: apiKey.trim() };
}

const bootPrompt = (userIntent: string) => `
You are bootstrapping a new workspace for the user. Their stated purpose is:
"${userIntent}"

## Important: Interview the User

If asked to read from a BOOT.md file, you must read it first. There will be information useful for you to help the user.

If there is a mention of Skills in either Markdown or JSON in the BOOT.md, you MUST use those to create skill files in your current working directory in the path .opencode/skills/<name>/SKILL.md.

NEVER ASK QUESTIONS

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

interface BinaryMapping {
  linkName: string;
  target: string;
}

async function installToolForEval(
  name: string,
  url: string,
  prefix: string,
  binaryMappings: BinaryMapping[],
): Promise<void> {
  const toolsDir = join(prefix, "tools", name);
  const binDir = join(prefix, "bin");
  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const archiveName = url.split("/").pop()!;
  const archivePath = join(prefix, "tools", archiveName);

  // Download
  const downloadProc = Bun.spawn(["curl", "-fSL", "-o", archivePath, url], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await downloadProc.exited) !== 0) {
    throw new Error(`Failed to download ${url}`);
  }

  // Extract (handle both .tar.gz and .zip)
  if (archivePath.endsWith(".zip")) {
    const extractProc = Bun.spawn(["unzip", "-o", archivePath, "-d", toolsDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await extractProc.exited) !== 0) {
      throw new Error(`Failed to extract ${archiveName}`);
    }
  } else {
    const extractProc = Bun.spawn(["tar", "xf", archivePath, "-C", toolsDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await extractProc.exited) !== 0) {
      throw new Error(`Failed to extract ${archiveName}`);
    }
  }

  // Create symlinks
  for (const mapping of binaryMappings) {
    const linkPath = join(binDir, mapping.linkName);
    const targetAbsolute = join(toolsDir, mapping.target);

    if (!existsSync(targetAbsolute)) {
      console.warn(`  Warning: binary not found at ${targetAbsolute}`);
      continue;
    }

    chmodSync(targetAbsolute, 0o755);

    const relTarget = relative(binDir, targetAbsolute);
    if (existsSync(linkPath)) {
      unlinkSync(linkPath);
    }
    symlinkSync(relTarget, linkPath);
  }

  // Clean up archive
  unlinkSync(archivePath);
}

function generateEvalOpencodeConfig(model?: string): string {
  return JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    ...(model && { model }),
    "permission": {
      "edit": "allow",
      "bash": "allow",
      "webfetch": "allow",
      "write": "allow",
      "codesearch": "allow",
      "read": "allow",
      "grep": "allow",
      "glob": "allow",
      "list": "allow",
      "lsp": "allow",
      "skill": "allow",
      "todowrite": "allow",
      "todoread": "allow",
      "question": "allow"
    }
  }, null, 2);
}

async function installEvalEnvironment(prefix: string): Promise<void> {
  const platform = detectPlatform();

  console.log("Installing python...");
  const py = pythonUrl(platform);
  await installToolForEval("python", py.url, prefix, [
    { linkName: "python3", target: py.extractedBinary },
    { linkName: "python", target: py.extractedBinary },
  ]);

  console.log("Installing uv...");
  const uv = uvUrl(platform);
  await installToolForEval("uv", uv.url, prefix, [
    { linkName: "uv", target: uv.extractedBinary },
  ]);

  console.log("Installing ripgrep...");
  const rg = ripgrepUrl(platform);
  await installToolForEval("ripgrep", rg.url, prefix, [
    { linkName: "rg", target: rg.extractedBinary },
  ]);

  console.log("Installing opencode...");
  const oc = opencodeUrl(platform);
  await installToolForEval("opencode", oc.url, prefix, [
    { linkName: "opencode", target: oc.extractedBinary },
  ]);

  // Create XDG directories
  for (const dir of ["config", "share", "cache", "state"]) {
    mkdirSync(join(prefix, dir), { recursive: true });
  }
}

export async function bootEval(pathToTestFile: string): Promise<BootEvalResult> {
  debugger;
  // Read test struct and BOOT.md content
  const testStruct = await Bun.file(pathToTestFile).json() as BootEvalStruct;
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
    await Bun.write(join(workspace, "opencode.json"), generateEvalOpencodeConfig(testStruct.model));

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
      env: { ...process.env, ...xdgEnv, PATH: buildPath(prefix) },
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
          const events = await client.event.subscribe({}, { signal: abort.signal });
          for await (const event of events.stream) {
            // Only process events for our session
            const eventSessionId = event.properties?.sessionID ?? (event.properties as any)?.sessionID;
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
              await client.permission.reply({ requestID: req.id, reply: "once" });
            }

            // Session completed
            if (event.type === "session.idle" && event.properties.sessionID === sessionId) {
              console.log("\n[Session] Idle - completed");
              resolve();
              return;
            }

            // Session error
            if (event.type === "session.error" && (event.properties as any).sessionID === sessionId) {
              console.log(`\n[Session] Error: ${JSON.stringify(event.properties)}`);
              reject(new Error(`Session error: ${JSON.stringify(event.properties)}`));
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
      setTimeout(() => reject(new Error("Boot eval timed out after 10 minutes")), 10 * 60 * 1000);
    });
    await Promise.race([sessionComplete, timeout]);
    abort.abort();

    // Collect output files
    const files: FileResult[] = [];
    let fullContent = "";

    for (const skillPath of testStruct.output.skillsPaths) {
      const fullPath = join(workspace, skillPath);
      const found = existsSync(fullPath);
      if (found) {
        const content = await Bun.file(fullPath).text();
        files.push({ file: skillPath, found: true, content });
        fullContent += `<skills path: ${skillPath}>\n${content}\n`;
      } else {
        files.push({ file: skillPath, found: false, content: null });
      }
    }

    const agentsMdFullPath = join(workspace, testStruct.output.agentsMdPath);
    const agentsMdFound = existsSync(agentsMdFullPath);
    if (agentsMdFound) {
      const content = await Bun.file(agentsMdFullPath).text();
      files.push({ file: testStruct.output.agentsMdPath, found: true, content });
      fullContent += `<agentsMd path: ${testStruct.output.agentsMdPath}>\n${content}\n`;
    } else {
      files.push({ file: testStruct.output.agentsMdPath, found: false, content: null });
    }

    console.log("Boot eval complete.");
    console.log(`=== RESULTS ===`)
    for (const fileResult of files) {
      console.log(`File: ${fileResult.file}, Found: ${fileResult.found}`);
    }
    return { files, fullContent };

  } finally {
    // Cleanup
    if (serverProc) serverProc.kill();
    rmSync(tempBase, { recursive: true, force: true });
  }
}
