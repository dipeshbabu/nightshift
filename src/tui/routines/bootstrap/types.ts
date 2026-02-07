import type { OpencodeClient, QuestionRequest, QuestionAnswer } from "@opencode-ai/sdk/v2";
import type { createCliRenderer, TextRenderable } from "@opentui/core";

// Re-export question types for external use
export type { QuestionRequest, QuestionAnswer } from "@opencode-ai/sdk/v2";

// Re-export FileDiff from shared lib
export type { FileDiff } from "../../lib/diff";

export interface BootstrapUI {
  appendText: (text: string) => void;
  appendToolStatus: (status: "running" | "completed" | "error", text: string) => void;
  setStatus: (status: string) => void;
  showDiff: (diffs: import("../../lib/diff").FileDiff[]) => void;
  showBashOutput: (command: string, output: string, description?: string) => void;
  showWriteOutput: (filePath: string, content: string) => void;
  showEditOutput: (filePath: string, diff: string) => void;
  setSpinnerActive: (active: boolean) => void;
  /** Display a question to the user and get their response */
  showQuestion: (request: QuestionRequest) => Promise<QuestionAnswer[]>;
}

export interface BootstrapPromptOptions {
  /** Custom renderer for testing. If not provided, creates a CLI renderer. */
  renderer?: ReturnType<typeof createCliRenderer> extends Promise<infer R> ? R : never;
  /** Skip TTY check for testing. Default: false */
  skipTtyCheck?: boolean;
  /** Auto-start the renderer. Default: true (set to false for testing) */
  autoStart?: boolean;
  /** The prefix directory where tools are installed */
  prefix: string;
  /** The workspace path */
  workspacePath: string;
  /** XDG environment variables for isolated config/data/cache/state */
  xdgEnv: Record<string, string>;
}

export interface BootstrapPromptResult {
  intent: string | null;
  client: OpencodeClient;
  serverUrl: string;
  serverProc: ReturnType<typeof Bun.spawn>;
  model: { providerID: string; modelID: string };
}

export interface ProviderOption {
  id: string;
  name: string;
  description: string;
}

export interface ModelOption {
  providerID: string;
  modelID: string;
  name: string;
}

export type ViewState =
  | { type: "loading" }
  | { type: "provider-select"; selectedIndex: number }
  | { type: "auth-method-select"; providerId: string; methods: Array<{ type: string; label: string }>; selectedIndex: number }
  | { type: "oauth-auto"; providerId: string; methodIndex: number; url: string; instructions: string }
  | { type: "oauth-code"; providerId: string; methodIndex: number; url: string; instructions: string; error?: boolean }
  | { type: "api-key"; providerId: string; error?: boolean }
  | { type: "model-select"; models: ModelOption[] }
  | { type: "intent-prompt" }
  | { type: "bootstrap-output" }
  | { type: "question"; request: QuestionRequest; resolve: (answers: QuestionAnswer[]) => void; reject: (err: Error) => void; currentQuestionIndex: number; answers: QuestionAnswer[]; customInputActive: boolean; selectedIndex: number };

export interface BootstrapState {
  viewState: ViewState;
  selectedModel: ModelOption | null;
  resolved: boolean;
  outputCounter: number;
  oauthAbort: AbortController | null;
  currentTextNode: TextRenderable | null;
  currentTextContent: string;
}
