import type { ProviderConfig, ApiKeyResult } from "./types";

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

export async function ensureApiKey(model?: string): Promise<ApiKeyResult> {
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
