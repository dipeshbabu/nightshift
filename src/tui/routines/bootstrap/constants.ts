import type { ProviderOption } from "./types";

export { COLORS, syntaxStyle, TOOL_STATUS_CONFIG, SELECT_STYLE, INPUT_STYLE, DIFF_COLORS } from "../../lib/theme";

export const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: "anthropic", name: "Anthropic", description: "(Claude Max or API key)" },
  { id: "openai", name: "OpenAI", description: "(ChatGPT Plus/Pro or API key)" },
];
