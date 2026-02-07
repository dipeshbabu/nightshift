import { SyntaxStyle, RGBA } from "@opentui/core";
import type { ProviderOption } from "./types";

export const COLORS = {
  primary: "#fab283",
  text: "#eeeeee",
  textMuted: "#808080",
  background: "#303030",
  backgroundPanel: "#262626",
  toolRunning: "#61afef",
  toolCompleted: "#98c379",
  toolError: "#e06c75",
};

export const syntaxStyle = SyntaxStyle.fromStyles({
  keyword: { fg: RGBA.fromHex("#FF7B72"), bold: true },
  string: { fg: RGBA.fromHex("#A5D6FF") },
  comment: { fg: RGBA.fromHex("#8B949E"), italic: true },
  number: { fg: RGBA.fromHex("#79C0FF") },
  function: { fg: RGBA.fromHex("#D2A8FF") },
  default: { fg: RGBA.fromHex("#E6EDF3") },
});

export const TOOL_STATUS_CONFIG = {
  running: { prefix: "▶", color: COLORS.toolRunning },
  completed: { prefix: "✓", color: COLORS.toolCompleted },
  error: { prefix: "✗", color: COLORS.toolError },
} as const;

export const SELECT_STYLE = {
  backgroundColor: COLORS.backgroundPanel,
  textColor: COLORS.text,
  selectedBackgroundColor: COLORS.primary,
  selectedTextColor: "#000000",
  descriptionColor: COLORS.textMuted,
  selectedDescriptionColor: "#000000",
  wrapSelection: true,
} as const;

export const INPUT_STYLE = {
  height: 1,
  textColor: COLORS.text,
  focusedTextColor: "#ffffff",
  cursorColor: COLORS.primary,
  placeholderColor: COLORS.textMuted,
} as const;

export const DIFF_COLORS = {
  addedBg: RGBA.fromHex("#1a3d1a"),
  removedBg: RGBA.fromHex("#3d1a1a"),
  addedSignColor: RGBA.fromHex("#98c379"),
  removedSignColor: RGBA.fromHex("#e06c75"),
  fg: RGBA.fromHex("#e6edf3"),
} as const;

export const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: "anthropic", name: "Anthropic", description: "(Claude Max or API key)" },
  { id: "openai", name: "OpenAI", description: "(ChatGPT Plus/Pro or API key)" },
];
