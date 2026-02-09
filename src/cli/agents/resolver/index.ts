import type { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { runSession } from "../session";
import { resolverPrompt } from "../../../lib/prompts/resolver";
import type { EventPublisher } from "../bus";

export interface ResolverOptions {
  client: ReturnType<typeof createOpencodeClient>;
  worktreePath: string;
  conflicts: string;
  model: string;
  bus?: EventPublisher;
}

export interface ResolverResult {
  output: string;
}

export async function resolve(options: ResolverOptions): Promise<ResolverResult> {
  const { client, conflicts, model, bus } = options;

  if (bus) {
    bus.publish({ type: "resolver.start", timestamp: Date.now(), conflicts });
  }

  const prompt = resolverPrompt(conflicts);

  const { output } = await runSession({
    client,
    prompt,
    title: "merge-resolver",
    model,
    phase: "resolver",
    bus,
  });

  if (bus) {
    bus.publish({ type: "resolver.complete", timestamp: Date.now() });
  }

  return { output };
}
