import {
  createCliRenderer,
  TextRenderable,
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  DiffRenderable,
  SyntaxStyle,
  RGBA,
  SelectRenderable,
  SelectRenderableEvents,
} from "@opentui/core";
import { SpinnerRenderable } from "opentui-spinner";
import { createFrames, createColors } from "./cli/cmd/tui/tui/ui/spinner";
import stripAnsi from "strip-ansi";
import { join } from "path";
import open from "open";
import type { OpencodeClient, QuestionRequest, QuestionAnswer } from "@opencode-ai/sdk/v2";

// Colors for the bootstrap UI
const COLORS = {
  primary: "#fab283",
  text: "#eeeeee",
  textMuted: "#808080",
  background: "#303030",
  backgroundPanel: "#262626",
  toolRunning: "#61afef",
  toolCompleted: "#98c379",
  toolError: "#e06c75",
};

// Syntax style for code highlighting in diffs
const syntaxStyle = SyntaxStyle.fromStyles({
  keyword: { fg: RGBA.fromHex("#FF7B72"), bold: true },
  string: { fg: RGBA.fromHex("#A5D6FF") },
  comment: { fg: RGBA.fromHex("#8B949E"), italic: true },
  number: { fg: RGBA.fromHex("#79C0FF") },
  function: { fg: RGBA.fromHex("#D2A8FF") },
  default: { fg: RGBA.fromHex("#E6EDF3") },
});

export interface FileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

// Re-export question types for external use
export type { QuestionRequest, QuestionAnswer } from "@opencode-ai/sdk/v2";

export interface BootstrapUI {
  appendText: (text: string) => void;
  appendToolStatus: (status: "running" | "completed" | "error", text: string) => void;
  setStatus: (status: string) => void;
  showDiff: (diffs: FileDiff[]) => void;
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

/**
 * Convert FileDiff to unified diff format
 */
function toUnifiedDiff(diff: FileDiff): string {
  const beforeLines = diff.before.split("\n");
  const afterLines = diff.after.split("\n");

  let result = `--- a/${diff.file}\n+++ b/${diff.file}\n`;

  // Simple unified diff - show all as changed
  if (beforeLines.length > 0 || afterLines.length > 0) {
    result += `@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n`;
    for (const line of beforeLines) {
      if (line || beforeLines.length === 1) {
        result += `-${line}\n`;
      }
    }
    for (const line of afterLines) {
      if (line || afterLines.length === 1) {
        result += `+${line}\n`;
      }
    }
  }

  return result;
}

/**
 * Get file extension for syntax highlighting
 */
function getFiletype(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mapping: Record<string, string> = {
    py: "python",
    js: "javascript",
    ts: "typescript",
    tsx: "tsx",
    jsx: "jsx",
    md: "markdown",
    json: "json",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
  };
  return ext ? mapping[ext] : undefined;
}

// Tool status configuration for appendToolStatus
const TOOL_STATUS_CONFIG = {
  running: { prefix: "▶", color: COLORS.toolRunning },
  completed: { prefix: "✓", color: COLORS.toolCompleted },
  error: { prefix: "✗", color: COLORS.toolError },
} as const;

// Shared styling for SelectRenderable instances
const SELECT_STYLE = {
  backgroundColor: COLORS.backgroundPanel,
  textColor: COLORS.text,
  selectedBackgroundColor: COLORS.primary,
  selectedTextColor: "#000000",
  descriptionColor: COLORS.textMuted,
  selectedDescriptionColor: "#000000",
  wrapSelection: true,
} as const;

// Shared styling for InputRenderable instances
const INPUT_STYLE = {
  height: 1,
  textColor: COLORS.text,
  focusedTextColor: "#ffffff",
  cursorColor: COLORS.primary,
  placeholderColor: COLORS.textMuted,
} as const;

// Diff renderable colors used in multiple places
const DIFF_COLORS = {
  addedBg: RGBA.fromHex("#1a3d1a"),
  removedBg: RGBA.fromHex("#3d1a1a"),
  addedSignColor: RGBA.fromHex("#98c379"),
  removedSignColor: RGBA.fromHex("#e06c75"),
  fg: RGBA.fromHex("#e6edf3"),
} as const;

function buildPath(prefix: string): string {
  const { existsSync } = require("fs");
  const binDir = join(prefix, "bin");
  const uvToolsBin = join(prefix, "uv-tools", "bin");
  let pathParts = [binDir];
  if (existsSync(uvToolsBin)) pathParts.unshift(uvToolsBin);
  return `${pathParts.join(":")}:${process.env.PATH ?? ""}`;
}

async function waitForServer(url: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${url}/global/health`);
      if (response.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Server failed to start within timeout");
}

// Provider info for the selection dialog
interface ProviderOption {
  id: string;
  name: string;
  description: string;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: "anthropic", name: "Anthropic", description: "(Claude Max or API key)" },
  { id: "openai", name: "OpenAI", description: "(ChatGPT Plus/Pro or API key)" },
];

// Model info for selection dialog
interface ModelOption {
  providerID: string;
  modelID: string;
  name: string;
}

type ViewState =
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

/**
 * Shows a TUI prompt for provider selection, model selection, and user intent.
 * @param onBootstrap - Called with the user's intent, UI interface, SDK client, server URL, and selected model
 * @param options - Configuration including prefix, workspacePath, and xdgEnv
 * @returns The user's intent string, or null if they skipped (Ctrl+C), along with the SDK client and selected model
 */
export async function runBootstrapPrompt(
  onBootstrap: (intent: string, ui: BootstrapUI, client: OpencodeClient, serverUrl: string, model: { providerID: string; modelID: string }) => Promise<void>,
  options: BootstrapPromptOptions
): Promise<BootstrapPromptResult | null> {
  const { renderer: customRenderer, skipTtyCheck = false, autoStart = true, prefix, workspacePath, xdgEnv } = options;

  // Check if we're in a TTY
  if (!skipTtyCheck && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.log("Not running in a TTY, skipping bootstrap prompt.");
    return null;
  }

  const renderer = customRenderer ?? await createCliRenderer({
    exitOnCtrlC: true,
  });

  // Start opencode server early
  const binDir = join(prefix, "bin");
  const opencodePath = join(binDir, "opencode");
  const port = 4096 + Math.floor(Math.random() * 1000);
  const serverUrl = `http://127.0.0.1:${port}`;

  const serverProc = Bun.spawn([opencodePath, "serve", "--port", String(port)], {
    cwd: workspacePath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...xdgEnv, PATH: buildPath(prefix) },
  });

  // Import SDK client
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
  let client: OpencodeClient;

  return new Promise<BootstrapPromptResult | null>(async (resolve, reject) => {
    let resolved = false;
    let outputCounter = 0;
    let viewState: ViewState = { type: "loading" };

    // UI elements that will be created
    let statusText: TextRenderable;
    let scrollBox: ScrollBoxRenderable;
    let spinner: SpinnerRenderable;

    // Containers for different views
    let loadingContainer: BoxRenderable;
    let providerSelectContainer: BoxRenderable;
    let authMethodContainer: BoxRenderable;
    let oauthAutoContainer: BoxRenderable;
    let oauthCodeContainer: BoxRenderable;
    let apiKeyContainer: BoxRenderable;
    let modelSelectContainer: BoxRenderable;
    let intentContainer: BoxRenderable;
    let outputContainer: BoxRenderable;
    let questionContainer: BoxRenderable;

    // UI elements we need to update
    let providerSelect: SelectRenderable;
    let authMethodSelect: SelectRenderable;
    let oauthUrlText: TextRenderable;
    let oauthInstructionsText: TextRenderable;
    let oauthWaitingText: TextRenderable;
    let oauthCodeUrlText: TextRenderable;
    let oauthCodeInstructionsText: TextRenderable;
    let codeInput: InputRenderable;
    let codeErrorText: TextRenderable;
    let apiKeyInput: InputRenderable;
    let apiKeyErrorText: TextRenderable;
    let modelSelect: SelectRenderable;
    let intentInput: InputRenderable;
    let questionHeaderText: TextRenderable;
    let questionLabel: TextRenderable;
    let questionSelect: SelectRenderable;
    let questionCustomInput: InputRenderable;
    let questionHelpText: TextRenderable;

    // Track selected model
    let selectedModel: ModelOption | null = null;

    // Helper to destroy renderer (skip for custom renderers used in testing)
    const destroyRenderer = () => {
      if (!customRenderer) renderer.destroy();
    };

    const cleanup = async (value: BootstrapPromptResult | null) => {
      if (resolved) return;
      resolved = true;
      destroyRenderer();
      if (!value) serverProc.kill();
      resolve(value);
    };

    const cleanupWithError = (err: unknown) => {
      if (resolved) return;
      resolved = true;
      destroyRenderer();
      serverProc.kill();
      reject(err);
    };

    // Create spinner frames and colors for knight rider effect
    const spinnerDef = {
      frames: createFrames({
        color: COLORS.primary,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
      colors: createColors({
        color: COLORS.primary,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
    };

    // Helper to create a standard view container
    const createViewContainer = (id: string, visible = false) =>
      new BoxRenderable(renderer, {
        id,
        flexDirection: "column",
        gap: 1,
        padding: 1,
        visible,
      });

    // Helper to create a spinner with standard config
    const createSpinner = () =>
      new SpinnerRenderable(renderer, {
        frames: spinnerDef.frames,
        color: spinnerDef.colors,
        interval: 40,
      });

    // Create main container
    const container = new BoxRenderable(renderer, {
      id: "container",
      flexDirection: "column",
      width: "100%",
      height: "100%",
    });

    loadingContainer = createViewContainer("loading-container", true);

    const loadingSpinner = createSpinner();

    const loadingText = new TextRenderable(renderer, {
      id: "loading-text",
      content: "Starting server...",
      fg: COLORS.primary,
    });

    const loadingRow = new BoxRenderable(renderer, {
      id: "loading-row",
      flexDirection: "row",
      gap: 1,
    });
    loadingRow.add(loadingSpinner);
    loadingRow.add(loadingText);
    loadingContainer.add(loadingRow);

    providerSelectContainer = createViewContainer("provider-select-container");

    const providerLabel = new TextRenderable(renderer, {
      id: "provider-label",
      content: ":> Connect a provider",
      fg: COLORS.primary,
    });

    // Create SelectRenderable for provider options
    providerSelect = new SelectRenderable(renderer, {
      id: "provider-select",
      options: [
        ...PROVIDER_OPTIONS.map(opt => ({
          name: opt.name,
          description: opt.description,
          value: opt.id,
        })),
        { name: "Skip", description: "(Continue without auth)", value: "skip" },
      ],
      width: 50,
      height: 5,
      ...SELECT_STYLE,
    });

    const providerHelpText = new TextRenderable(renderer, {
      id: "provider-help",
      content: "Use ↑/↓ to select, Enter to confirm",
      fg: COLORS.textMuted,
    });

    providerSelectContainer.add(providerLabel);
    providerSelectContainer.add(providerSelect);
    providerSelectContainer.add(providerHelpText);

    authMethodContainer = createViewContainer("auth-method-container");

    const authMethodLabel = new TextRenderable(renderer, {
      id: "auth-method-label",
      content: ":> Select auth method",
      fg: COLORS.primary,
    });

    // Create SelectRenderable for auth methods 
    authMethodSelect = new SelectRenderable(renderer, {
      id: "auth-method-select",
      options: [],
      width: 50,
      height: 4,
      ...SELECT_STYLE,
    });

    const authMethodHelpText = new TextRenderable(renderer, {
      id: "auth-method-help",
      content: "Use ↑/↓ to select, Enter to confirm, Esc to go back",
      fg: COLORS.textMuted,
    });

    authMethodContainer.add(authMethodLabel);
    authMethodContainer.add(authMethodSelect);
    authMethodContainer.add(authMethodHelpText);

    oauthAutoContainer = createViewContainer("oauth-auto-container");

    const oauthAutoLabel = new TextRenderable(renderer, {
      id: "oauth-auto-label",
      content: ":> Authenticate",
      fg: COLORS.primary,
    });

    oauthUrlText = new TextRenderable(renderer, {
      id: "oauth-url",
      content: "",
      fg: COLORS.primary,
    });

    oauthInstructionsText = new TextRenderable(renderer, {
      id: "oauth-instructions",
      content: "",
      fg: COLORS.textMuted,
    });

    const oauthAutoSpinner = createSpinner();

    oauthWaitingText = new TextRenderable(renderer, {
      id: "oauth-waiting",
      content: "Waiting for authorization...",
      fg: COLORS.textMuted,
    });

    const oauthWaitingRow = new BoxRenderable(renderer, {
      id: "oauth-waiting-row",
      flexDirection: "row",
      gap: 1,
    });
    oauthWaitingRow.add(oauthAutoSpinner);
    oauthWaitingRow.add(oauthWaitingText);

    const oauthAutoEscText = new TextRenderable(renderer, {
      id: "oauth-auto-esc",
      content: "Press Esc to cancel",
      fg: COLORS.textMuted,
    });

    oauthAutoContainer.add(oauthAutoLabel);
    oauthAutoContainer.add(oauthUrlText);
    oauthAutoContainer.add(oauthInstructionsText);
    oauthAutoContainer.add(oauthWaitingRow);
    oauthAutoContainer.add(oauthAutoEscText);

    oauthCodeContainer = createViewContainer("oauth-code-container");

    const oauthCodeLabel = new TextRenderable(renderer, {
      id: "oauth-code-label",
      content: ":> Enter authorization code",
      fg: COLORS.primary,
    });

    oauthCodeUrlText = new TextRenderable(renderer, {
      id: "oauth-code-url",
      content: "",
      fg: COLORS.primary,
    });

    oauthCodeInstructionsText = new TextRenderable(renderer, {
      id: "oauth-code-instructions",
      content: "",
      fg: COLORS.textMuted,
    });

    codeInput = new InputRenderable(renderer, {
      id: "code-input",
      width: 40,
      placeholder: "Authorization code",
      ...INPUT_STYLE,
    });

    codeErrorText = new TextRenderable(renderer, {
      id: "code-error",
      content: "Invalid code",
      fg: COLORS.toolError,
      visible: false,
    });

    const oauthCodeHelpText = new TextRenderable(renderer, {
      id: "oauth-code-help",
      content: "Press Enter to submit, Esc to go back",
      fg: COLORS.textMuted,
    });

    oauthCodeContainer.add(oauthCodeLabel);
    oauthCodeContainer.add(oauthCodeUrlText);
    oauthCodeContainer.add(oauthCodeInstructionsText);
    oauthCodeContainer.add(codeInput);
    oauthCodeContainer.add(codeErrorText);
    oauthCodeContainer.add(oauthCodeHelpText);

    apiKeyContainer = createViewContainer("api-key-container");

    const apiKeyLabel = new TextRenderable(renderer, {
      id: "api-key-label",
      content: ":> Enter API key",
      fg: COLORS.primary,
    });

    apiKeyInput = new InputRenderable(renderer, {
      id: "api-key-input",
      width: 60,
      placeholder: "API key",
      ...INPUT_STYLE,
    });

    apiKeyErrorText = new TextRenderable(renderer, {
      id: "api-key-error",
      content: "Invalid API key",
      fg: COLORS.toolError,
      visible: false,
    });

    const apiKeyHelpText = new TextRenderable(renderer, {
      id: "api-key-help",
      content: "Press Enter to submit, Esc to go back",
      fg: COLORS.textMuted,
    });

    apiKeyContainer.add(apiKeyLabel);
    apiKeyContainer.add(apiKeyInput);
    apiKeyContainer.add(apiKeyErrorText);
    apiKeyContainer.add(apiKeyHelpText);

    modelSelectContainer = createViewContainer("model-select-container");

    const modelSelectLabel = new TextRenderable(renderer, {
      id: "model-select-label",
      content: ":> Select a model",
      fg: COLORS.primary,
    });

    // Create SelectRenderable for model options (will be populated dynamically)
    modelSelect = new SelectRenderable(renderer, {
      id: "model-select",
      options: [],
      width: 50,
      height: 8,
      ...SELECT_STYLE,
    });

    const modelSelectHelpText = new TextRenderable(renderer, {
      id: "model-select-help",
      content: "Use ↑/↓ to select, Enter to confirm",
      fg: COLORS.textMuted,
    });

    modelSelectContainer.add(modelSelectLabel);
    modelSelectContainer.add(modelSelect);
    modelSelectContainer.add(modelSelectHelpText);

    intentContainer = createViewContainer("intent-container");

    const intentLabel = new TextRenderable(renderer, {
      id: "intent-label",
      content: ":> What are you going to use nightshift for?",
      fg: COLORS.primary,
    });

    intentInput = new InputRenderable(renderer, {
      id: "intent-input",
      width: 60,
      placeholder: "e.g., managing my personal finances, analyzing data...",
      ...INPUT_STYLE,
    });

    const intentHelpText = new TextRenderable(renderer, {
      id: "intent-help",
      content: "Press Enter to submit, Ctrl+C to skip",
      fg: COLORS.textMuted,
    });

    intentContainer.add(intentLabel);
    intentContainer.add(intentInput);
    intentContainer.add(intentHelpText);

    // Question container for agent questions during bootstrap
    questionContainer = createViewContainer("question-container");

    questionHeaderText = new TextRenderable(renderer, {
      id: "question-header",
      content: "",
      fg: COLORS.textMuted,
    });

    questionLabel = new TextRenderable(renderer, {
      id: "question-label",
      content: "",
      fg: COLORS.primary,
    });

    questionSelect = new SelectRenderable(renderer, {
      id: "question-select",
      options: [],
      width: 60,
      height: 6,
      ...SELECT_STYLE,
    });

    questionCustomInput = new InputRenderable(renderer, {
      id: "question-custom-input",
      width: 60,
      placeholder: "Type your answer...",
      visible: false,
      ...INPUT_STYLE,
    });

    questionHelpText = new TextRenderable(renderer, {
      id: "question-help",
      content: "Use ↑/↓ to select, Enter to confirm, or type a custom answer",
      fg: COLORS.textMuted,
    });

    questionContainer.add(questionHeaderText);
    questionContainer.add(questionLabel);
    questionContainer.add(questionSelect);
    questionContainer.add(questionCustomInput);
    questionContainer.add(questionHelpText);

    outputContainer = new BoxRenderable(renderer, {
      id: "output-container",
      flexDirection: "column",
      flexGrow: 1,
      padding: 1,
      visible: false,
    });

    const statusContainer = new BoxRenderable(renderer, {
      id: "status-container",
      flexDirection: "row",
      gap: 1,
      height: 1,
    });

    spinner = createSpinner();

    statusText = new TextRenderable(renderer, {
      id: "status",
      content: "Bootstrapping...",
      fg: COLORS.primary,
    });

    statusContainer.add(spinner);
    statusContainer.add(statusText);

    const contentBox = new BoxRenderable(renderer, {
      id: "content-box",
      flexDirection: "column",
      flexGrow: 1,
    });

    scrollBox = new ScrollBoxRenderable(renderer, {
      id: "scroll",
      flexGrow: 1,
      width: "100%",
      stickyScroll: true,
      stickyStart: "bottom",
    });

    contentBox.add(scrollBox);
    outputContainer.add(statusContainer);
    outputContainer.add(contentBox);

    // Add all containers to main container
    container.add(loadingContainer);
    container.add(providerSelectContainer);
    container.add(authMethodContainer);
    container.add(oauthAutoContainer);
    container.add(oauthCodeContainer);
    container.add(apiKeyContainer);
    container.add(modelSelectContainer);
    container.add(intentContainer);
    container.add(questionContainer);
    container.add(outputContainer);

    renderer.root.add(container);

    // Map view types to their containers for showView
    const viewContainers: Record<ViewState["type"], BoxRenderable> = {
      "loading": loadingContainer,
      "provider-select": providerSelectContainer,
      "auth-method-select": authMethodContainer,
      "oauth-auto": oauthAutoContainer,
      "oauth-code": oauthCodeContainer,
      "api-key": apiKeyContainer,
      "model-select": modelSelectContainer,
      "intent-prompt": intentContainer,
      "question": questionContainer,
      "bootstrap-output": outputContainer,
    };

    // Helper to show only one view
    const showView = (view: ViewState["type"]) => {
      for (const [type, container] of Object.entries(viewContainers)) {
        container.visible = type === view;
      }
    };

    // Helper to navigate back to provider selection
    const goToProviderSelect = () => {
      viewState = { type: "provider-select", selectedIndex: 0 };
      showView("provider-select");
      providerSelect.setSelectedIndex(0);
      providerSelect.focus();
    };

    // Helper to navigate to intent prompt
    const goToIntentPrompt = () => {
      viewState = { type: "intent-prompt" };
      showView("intent-prompt");
      intentInput.focus();
    };

    // Helper to set up API key view
    const goToApiKeyView = (providerId: string) => {
      viewState = { type: "api-key", providerId };
      showView("api-key");
      apiKeyInput.focus();
      apiKeyInput.value = "";
      apiKeyErrorText.visible = false;
    };

    // Helper to show loading view with a message
    const showLoading = (message: string) => {
      loadingText.content = message;
      viewState = { type: "loading" };
      showView("loading");
    };

    // Helper to set auth method options
    const setAuthMethodOptions = (methods: Array<{ type: string; label: string }>) => {
      authMethodSelect.options = methods.map((method, index) => ({
        name: method.label,
        description: method.type === "oauth" ? "Browser login" : "Enter key",
        value: index,
      }));
      authMethodSelect.setSelectedIndex(0);
    };

    // Track current text node for appending deltas to the same line
    let currentTextNode: TextRenderable | null = null;
    let currentTextContent = "";

    // Reset current text tracking (used before adding new output blocks)
    const resetTextTracking = () => {
      currentTextNode = null;
      currentTextContent = "";
    };

    // Create a styled output block box with left border
    const createOutputBlock = (blockId: string): BoxRenderable => {
      return new BoxRenderable(renderer, {
        id: blockId,
        flexDirection: "column",
        border: ["left"],
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 2,
        marginTop: 1,
        gap: 1,
        backgroundColor: COLORS.backgroundPanel,
        borderColor: COLORS.background,
      });
    };

    // Add expandable text content to a block with "click to expand" functionality
    const addExpandableContent = (
      blockBox: BoxRenderable,
      blockId: string,
      content: string,
      lines: string[],
    ) => {
      const truncated = lines.length > 10;
      let expanded = false;

      const contentText = new TextRenderable(renderer, {
        id: `${blockId}-content`,
        content: truncated ? lines.slice(0, 10).join("\n") : content,
        fg: COLORS.text,
        wrapMode: "word",
      });
      blockBox.add(contentText);

      if (truncated) {
        const moreText = new TextRenderable(renderer, {
          id: `${blockId}-more`,
          content: `... (${lines.length - 10} more lines) - click to expand`,
          fg: COLORS.textMuted,
          onMouseUp: () => {
            expanded = !expanded;
            contentText.content = expanded ? content : lines.slice(0, 10).join("\n");
            moreText.content = expanded
              ? "click to collapse"
              : `... (${lines.length - 10} more lines) - click to expand`;
          },
          onMouseOver: function() {
            this.fg = COLORS.primary;
          },
          onMouseOut: function() {
            this.fg = COLORS.textMuted;
          },
        });
        blockBox.add(moreText);
      }
    };

    // Create UI interface for bootstrap process
    const ui: BootstrapUI = {
      appendText: (text: string) => {
        if (!text) return;
        if (currentTextNode) {
          currentTextContent += text;
          currentTextNode.content = currentTextContent;
        } else {
          currentTextContent = text;
          currentTextNode = new TextRenderable(renderer, {
            id: `output-${outputCounter++}`,
            content: currentTextContent,
            fg: COLORS.text,
            wrapMode: "word",
          });
          scrollBox.add(currentTextNode);
        }
      },
      appendToolStatus: (status: "running" | "completed" | "error", text: string) => {
        resetTextTracking();
        const { prefix, color } = TOOL_STATUS_CONFIG[status];
        const statusNode = new TextRenderable(renderer, {
          id: `status-${outputCounter++}`,
          content: `${prefix} ${text}`,
          fg: color,
        });
        scrollBox.add(statusNode);
      },
      setStatus: (status: string) => {
        statusText.content = status;
      },
      showDiff: (diffs: FileDiff[]) => {
        resetTextTracking();

        for (const diff of diffs) {
          const headerNode = new TextRenderable(renderer, {
            id: `diff-header-${outputCounter++}`,
            content: `\n📄 ${diff.file} (+${diff.additions} -${diff.deletions})`,
            fg: COLORS.text,
          });
          scrollBox.add(headerNode);

          const unifiedDiff = toUnifiedDiff(diff);
          const filetype = getFiletype(diff.file);

          const diffRenderable = new DiffRenderable(renderer, {
            id: `diff-${outputCounter++}`,
            diff: unifiedDiff,
            view: "unified",
            syntaxStyle,
            filetype,
            showLineNumbers: true,
            ...DIFF_COLORS,
            width: "100%",
            height: Math.min(diff.additions + diff.deletions + 4, 20),
          });

          scrollBox.add(diffRenderable);
        }
      },
      showBashOutput: (command: string, output: string, description?: string) => {
        resetTextTracking();
        const blockId = `bash-${outputCounter++}`;
        const cleanOutput = stripAnsi(output.trim());
        const lines = cleanOutput.split("\n");

        const blockBox = createOutputBlock(blockId);

        const titleText = new TextRenderable(renderer, {
          id: `${blockId}-title`,
          content: description ? `# ${description}` : "# Shell",
          fg: COLORS.textMuted,
        });

        const commandText = new TextRenderable(renderer, {
          id: `${blockId}-cmd`,
          content: `$ ${command}`,
          fg: COLORS.text,
        });

        blockBox.add(titleText);
        blockBox.add(commandText);

        if (cleanOutput) {
          addExpandableContent(blockBox, blockId, cleanOutput, lines);
        }

        scrollBox.add(blockBox);
      },
      showWriteOutput: (filePath: string, content: string) => {
        resetTextTracking();
        const blockId = `write-${outputCounter++}`;
        const blockBox = createOutputBlock(blockId);

        const titleText = new TextRenderable(renderer, {
          id: `${blockId}-title`,
          content: `# Wrote ${filePath}`,
          fg: COLORS.textMuted,
        });

        blockBox.add(titleText);

        if (content && content.trim()) {
          const lines = content.split("\n");
          addExpandableContent(blockBox, blockId, content, lines);
        }

        scrollBox.add(blockBox);
      },
      showEditOutput: (filePath: string, diff: string) => {
        resetTextTracking();
        const blockId = `edit-${outputCounter++}`;
        const blockBox = createOutputBlock(blockId);

        const titleText = new TextRenderable(renderer, {
          id: `${blockId}-title`,
          content: `\u2190 Edit ${filePath}`,
          fg: COLORS.textMuted,
        });

        blockBox.add(titleText);

        if (diff && diff.trim()) {
          const diffRenderable = new DiffRenderable(renderer, {
            id: `${blockId}-diff`,
            diff: diff,
            view: "unified",
            syntaxStyle,
            filetype: getFiletype(filePath),
            showLineNumbers: true,
            ...DIFF_COLORS,
            width: "100%",
          });
          blockBox.add(diffRenderable);
        }

        scrollBox.add(blockBox);
      },
      setSpinnerActive: (active: boolean) => {
        spinner.visible = active;
      },
      showQuestion: (request: QuestionRequest): Promise<QuestionAnswer[]> => {
        return new Promise((resolve, reject) => {
          // Initialize question state
          const currentQuestionIndex = 0;
          const answers: QuestionAnswer[] = [];
          const question = request.questions[currentQuestionIndex];

          // Set up UI for first question
          questionHeaderText.content = question.header;
          questionLabel.content = `:> ${question.question}`;

          // Build options including "Type your own answer" if custom is allowed (default: true)
          const allowCustom = question.custom !== false;
          type QuestionSelectValue = { type: "option" | "custom"; index: number; label: string };
          const selectOptions: Array<{ name: string; description: string; value: QuestionSelectValue }> = question.options.map((opt, idx) => ({
            name: opt.label,
            description: opt.description,
            value: { type: "option", index: idx, label: opt.label },
          }));
          if (allowCustom) {
            selectOptions.push({
              name: "Other",
              description: "Type your own answer",
              value: { type: "custom", index: -1, label: "" },
            });
          }

          questionSelect.options = selectOptions;
          questionSelect.setSelectedIndex(0);
          questionSelect.visible = true;
          questionCustomInput.visible = false;
          questionHelpText.content = "Use ↑/↓ to select, Enter to confirm";

          // Transition to question view
          viewState = {
            type: "question",
            request,
            resolve,
            reject,
            currentQuestionIndex,
            answers,
            customInputActive: false,
            selectedIndex: 0,
          };
          showView("question");
          questionSelect.focus();
        });
      },
    };

    // Helper to process current question answer and move to next or complete
    const processQuestionAnswer = (answer: QuestionAnswer) => {
      if (viewState.type !== "question") return;

      const { request, resolve, currentQuestionIndex, answers } = viewState;
      answers.push(answer);

      const nextIndex = currentQuestionIndex + 1;
      if (nextIndex < request.questions.length) {
        // Move to next question
        const nextQuestion = request.questions[nextIndex];
        questionHeaderText.content = nextQuestion.header;
        questionLabel.content = `:> ${nextQuestion.question}`;

        const allowCustom = nextQuestion.custom !== false;
        type QuestionSelectValue = { type: "option" | "custom"; index: number; label: string };
        const selectOptions: Array<{ name: string; description: string; value: QuestionSelectValue }> = nextQuestion.options.map((opt, idx) => ({
          name: opt.label,
          description: opt.description,
          value: { type: "option", index: idx, label: opt.label },
        }));
        if (allowCustom) {
          selectOptions.push({
            name: "Other",
            description: "Type your own answer",
            value: { type: "custom", index: -1, label: "" },
          });
        }

        questionSelect.options = selectOptions;
        questionSelect.setSelectedIndex(0);
        questionSelect.visible = true;
        questionCustomInput.visible = false;
        questionCustomInput.value = "";
        questionHelpText.content = nextQuestion.multiple
          ? "Use ↑/↓ to select, Space to toggle, Enter to confirm"
          : "Use ↑/↓ to select, Enter to confirm";

        viewState = {
          ...viewState,
          currentQuestionIndex: nextIndex,
          answers,
          customInputActive: false,
          selectedIndex: 0,
        };
        questionSelect.focus();
      } else {
        // All questions answered, resolve and return to output view
        resolve(answers);
        viewState = { type: "bootstrap-output" };
        showView("bootstrap-output");
      }
    };

    // OAuth abort controller for cancellation
    let oauthAbort: AbortController | null = null;

    // Function to fetch available models and show model selection
    const showModelSelection = async (providerId: string) => {
      showLoading("Fetching available models...");

      try {
        // Get providers with models
        const providersResp = await client.config.providers();
        const providers = providersResp.data?.providers ?? [];

        // Find the selected provider and get its models (exclude deprecated)
        const provider = providers.find((p: any) => p.id === providerId);
        const models: ModelOption[] = provider
          ? Object.entries(provider.models ?? {})
            .filter(([_, m]: [string, any]) => m.status !== "deprecated")
            .map(([id, m]: [string, any]) => ({
              providerID: providerId,
              modelID: id,
              name: (m as any).name ?? id,
            }))
          : [];

        if (models.length === 0) {
          goToIntentPrompt();
          return;
        }

        // Update model select options
        modelSelect.options = models.map((m) => ({
          name: m.modelID,
          description: m.name !== m.modelID ? m.name : m.providerID,
          value: m,
        }));
        modelSelect.setSelectedIndex(0);

        viewState = { type: "model-select", models };
        showView("model-select");
        modelSelect.focus();
      } catch (err) {
        goToIntentPrompt();
      }
    };

    // Function to start OAuth auto flow (polling)
    const startOAuthAuto = async (providerId: string, methodIndex: number) => {
      oauthAbort = new AbortController();

      try {
        const result = await client.provider.oauth.callback({
          providerID: providerId,
          method: methodIndex,
        });

        if (oauthAbort.signal.aborted) return;

        if (result.error) {
          goToProviderSelect();
          return;
        }

        // Refresh provider state
        await client.instance.dispose();

        // Success - proceed to model selection for this provider
        await showModelSelection(providerId);
      } catch (err) {
        if (oauthAbort.signal.aborted) return;
        goToProviderSelect();
      }
    };

    // Function to select a provider and start auth
    const selectProvider = async (providerId: string) => {
      showLoading("Fetching auth methods...");

      // Get auth methods for this provider
      const authResponse = await client.provider.auth();
      const methods = authResponse.data?.[providerId] ?? [{ type: "api", label: "API key" }];

      if (methods.length === 1) {
        // Single method, proceed directly
        const method = methods[0];
        if (method.type === "oauth") {
          await startOAuth(providerId, 0, method.label);
        } else {
          goToApiKeyView(providerId);
        }
      } else {
        // Multiple methods, show selection
        viewState = { type: "auth-method-select", providerId, methods, selectedIndex: 0 };
        showView("auth-method-select");
        setAuthMethodOptions(methods);
        authMethodSelect.focus();
      }
    };

    // Function to start OAuth flow
    const startOAuth = async (providerId: string, methodIndex: number, label: string) => {
      const result = await client.provider.oauth.authorize({
        providerID: providerId,
        method: methodIndex,
      });

      if (!result.data) {
        goToProviderSelect();
        return;
      }

      const { url, method, instructions } = result.data;

      // Auto-open the URL in the browser
      open(url).catch(() => {
        // Ignore errors - user can still manually click the URL
      });

      if (method === "code") {
        // Manual code entry
        viewState = { type: "oauth-code", providerId, methodIndex, url, instructions };
        showView("oauth-code");
        oauthCodeUrlText.content = url;
        oauthCodeInstructionsText.content = instructions;
        codeInput.focus();
        codeInput.value = "";
        codeErrorText.visible = false;
      } else {
        // Auto polling
        viewState = { type: "oauth-auto", providerId, methodIndex, url, instructions };
        showView("oauth-auto");
        oauthUrlText.content = url;
        oauthInstructionsText.content = instructions;

        // Start polling
        startOAuthAuto(providerId, methodIndex);
      }
    };

    // Handle Ctrl+C globally
    renderer.keyInput.on("key", async (evt) => {
      if (evt.ctrl && evt.name === "c") {
        await cleanup(null);
        return;
      }

      // Handle question navigation and selection with direct keyboard events
      if (viewState.type === "question" && !viewState.customInputActive) {
        if (evt.name === "up" || evt.name === "k") {
          const total = questionSelect.options.length;
          const newIndex = (viewState.selectedIndex - 1 + total) % total;
          viewState = { ...viewState, selectedIndex: newIndex };
          questionSelect.setSelectedIndex(newIndex);
          return;
        }
        if (evt.name === "down" || evt.name === "j") {
          const total = questionSelect.options.length;
          const newIndex = (viewState.selectedIndex + 1) % total;
          viewState = { ...viewState, selectedIndex: newIndex };
          questionSelect.setSelectedIndex(newIndex);
          return;
        }
        if (evt.name === "return") {
          const selected = questionSelect.getSelectedOption();
          if (!selected) return;

          const value = selected.value as { type: "option" | "custom"; index: number; label: string };
          if (value.type === "custom") {
            viewState = { ...viewState, customInputActive: true };
            questionSelect.visible = false;
            questionCustomInput.visible = true;
            questionCustomInput.value = "";
            questionHelpText.content = "Type your answer and press Enter, or Esc to go back";
            questionCustomInput.focus();
          } else {
            processQuestionAnswer([value.label]);
          }
          return;
        }
      }

      // Handle escape for going back
      if (evt.name === "escape") {
        // Handle question view escape
        if (viewState.type === "question") {
          if (viewState.customInputActive) {
            // Go back from custom input to select
            viewState = { ...viewState, customInputActive: false };
            questionCustomInput.visible = false;
            questionSelect.visible = true;
            const question = viewState.request.questions[viewState.currentQuestionIndex];
            questionHelpText.content = question.multiple
              ? "Use ↑/↓ to select, Space to toggle, Enter to confirm"
              : "Use ↑/↓ to select, Enter to confirm";
            questionSelect.focus();
          } else {
            // Reject the question and return to output view
            viewState.reject(new Error("Question rejected by user"));
            viewState = { type: "bootstrap-output" };
            showView("bootstrap-output");
          }
          return;
        }

        const canGoBack = viewState.type === "auth-method-select" ||
          viewState.type === "oauth-auto" ||
          viewState.type === "oauth-code" ||
          viewState.type === "api-key" ||
          viewState.type === "model-select";

        if (canGoBack) {
          if (viewState.type === "oauth-auto") {
            oauthAbort?.abort();
          }
          goToProviderSelect();
        }
      }
    });

    // Handle provider selection
    providerSelect.on(SelectRenderableEvents.ITEM_SELECTED, async () => {
      const selected = providerSelect.getSelectedOption();
      if (!selected) return;

      if (selected.value === "skip") {
        goToIntentPrompt();
      } else {
        // Provider selected - start auth flow
        await selectProvider(selected.value);
      }
    });

    // Handle auth method selection
    authMethodSelect.on(SelectRenderableEvents.ITEM_SELECTED, async () => {
      if (viewState.type !== "auth-method-select") return;

      const selected = authMethodSelect.getSelectedOption();
      if (!selected) return;

      const methodIndex = selected.value as number;
      const method = viewState.methods[methodIndex];

      if (method.type === "oauth") {
        await startOAuth(viewState.providerId, methodIndex, method.label);
      } else {
        goToApiKeyView(viewState.providerId);
      }
    });

    // Handle code input Enter
    codeInput.on(InputRenderableEvents.ENTER, async () => {
      if (viewState.type !== "oauth-code") return;

      const code = codeInput.value?.trim();
      if (!code) return;

      const { error } = await client.provider.oauth.callback({
        providerID: viewState.providerId,
        method: viewState.methodIndex,
        code,
      });

      if (error) {
        codeErrorText.visible = true;
        return;
      }

      await client.instance.dispose();

      // Success - proceed to model selection for this provider
      await showModelSelection(viewState.providerId);
    });

    // Handle API key input Enter
    apiKeyInput.on(InputRenderableEvents.ENTER, async () => {
      if (viewState.type !== "api-key") return;

      const key = apiKeyInput.value?.trim();
      if (!key) return;

      await client.auth.set({
        providerID: viewState.providerId,
        auth: {
          type: "api",
          key,
        },
      });

      await client.instance.dispose();

      // Proceed to model selection for this provider
      await showModelSelection(viewState.providerId);
    });

    // Handle model selection
    modelSelect.on(SelectRenderableEvents.ITEM_SELECTED, async () => {
      const selected = modelSelect.getSelectedOption();
      if (!selected) return;

      // Store selected model
      selectedModel = selected.value as ModelOption;

      goToIntentPrompt();
    });

    // Handle question selection
    questionSelect.on(SelectRenderableEvents.ITEM_SELECTED, async () => {
      debugger; // Check if this event fires
      if (viewState.type !== "question") return;

      const selected = questionSelect.getSelectedOption();
      if (!selected) return;

      const value = selected.value as { type: "option" | "custom"; index: number; label: string };

      if (value.type === "custom") {
        // Switch to custom input mode
        viewState = { ...viewState, customInputActive: true };
        questionSelect.visible = false;
        questionCustomInput.visible = true;
        questionCustomInput.value = "";
        questionHelpText.content = "Type your answer and press Enter, or Esc to go back";
        questionCustomInput.focus();
      } else {
        processQuestionAnswer([value.label]);
      }
    });

    // Handle question custom input Enter
    questionCustomInput.on(InputRenderableEvents.ENTER, () => {
      if (viewState.type !== "question" || !viewState.customInputActive) return;

      const customAnswer = questionCustomInput.value?.trim();
      if (!customAnswer) return;

      processQuestionAnswer([customAnswer]);
    });

    // Handle intent input Enter
    intentInput.on(InputRenderableEvents.ENTER, async () => {
      if (viewState.type !== "intent-prompt") return;

      const intent = intentInput.value?.trim();
      if (!intent || resolved) return;

      // Transition to output view
      viewState = { type: "bootstrap-output" };
      showView("bootstrap-output");
      ui.setStatus(`Bootstrapping workspace for: ${intent}`);

      // Use selected model or a default fallback
      const model = selectedModel ?? { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" };

      // Save selected model to model.json before sending the prompt
      // Use XDG_STATE_HOME from xdgEnv for consistency with the XDG folder structure
      const stateHome = xdgEnv.XDG_STATE_HOME ?? join(prefix, "state");
      const opencodeStateDir = join(stateHome, "opencode");
      const modelJsonPath = join(opencodeStateDir, "model.json");
      const modelJson = {
        recent: [{ providerID: model.providerID, modelID: model.modelID }],
        favorite: [],
        variant: {},
      };
      try {
        const { mkdirSync } = await import("fs");
        mkdirSync(opencodeStateDir, { recursive: true });
        await Bun.write(modelJsonPath, JSON.stringify(modelJson, null, 2));
      } catch (err) {
        // Non-fatal error, continue with bootstrap
        console.error("Failed to save model.json:", err);
      }

      try {
        await onBootstrap(intent, ui, client, serverUrl, model);
        spinner.visible = false;
        ui.setStatus("✓ Bootstrap complete!");
        // Small delay so user can see completion message
        await new Promise((r) => setTimeout(r, 1000));
        await cleanup({ intent, client, serverUrl, serverProc, model });
      } catch (err) {
        cleanupWithError(err);
      }
    });

    // Start rendering (skip for testing when renderer is managed externally)
    if (autoStart) {
      renderer.start();
    }

    // Wait for server and show provider selection
    try {
      await waitForServer(serverUrl);
      client = createOpencodeClient({ baseUrl: serverUrl });
      goToProviderSelect();
    } catch (err) {
      cleanupWithError(err);
    }
  });
}
