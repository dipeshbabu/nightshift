import {
  TextRenderable,
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
} from "@opentui/core";
import { SpinnerRenderable } from "opentui-spinner";
import { createFrames, createColors } from "../tui/tui/ui/spinner";
import { COLORS, SELECT_STYLE, INPUT_STYLE, PROVIDER_OPTIONS } from "./constants";
import type { ViewState } from "./types";

type Renderer = ConstructorParameters<typeof BoxRenderable>[0];

export interface Views {
  container: BoxRenderable;
  loadingContainer: BoxRenderable;
  loadingText: TextRenderable;
  providerSelectContainer: BoxRenderable;
  providerSelect: SelectRenderable;
  authMethodContainer: BoxRenderable;
  authMethodSelect: SelectRenderable;
  oauthAutoContainer: BoxRenderable;
  oauthUrlText: TextRenderable;
  oauthInstructionsText: TextRenderable;
  oauthWaitingText: TextRenderable;
  oauthCodeContainer: BoxRenderable;
  oauthCodeUrlText: TextRenderable;
  oauthCodeInstructionsText: TextRenderable;
  codeInput: InputRenderable;
  codeErrorText: TextRenderable;
  apiKeyContainer: BoxRenderable;
  apiKeyInput: InputRenderable;
  apiKeyErrorText: TextRenderable;
  modelSelectContainer: BoxRenderable;
  modelSelect: SelectRenderable;
  intentContainer: BoxRenderable;
  intentInput: InputRenderable;
  questionContainer: BoxRenderable;
  questionHeaderText: TextRenderable;
  questionLabel: TextRenderable;
  questionSelect: SelectRenderable;
  questionCustomInput: InputRenderable;
  questionHelpText: TextRenderable;
  outputContainer: BoxRenderable;
  spinner: SpinnerRenderable;
  statusText: TextRenderable;
  scrollBox: ScrollBoxRenderable;
  viewContainers: Record<ViewState["type"], BoxRenderable>;
}

const createSpinnerDef = () => {
  const config = { color: COLORS.primary, style: "blocks" as const, inactiveFactor: 0.6, minAlpha: 0.3 };
  return {
    frames: createFrames(config),
    colors: createColors(config),
  };
};

const createViewContainer = (renderer: Renderer, id: string, visible = false) =>
  new BoxRenderable(renderer, {
    id,
    flexDirection: "column",
    gap: 1,
    padding: 1,
    visible,
  });

const createSpinner = (renderer: Renderer, spinnerDef: ReturnType<typeof createSpinnerDef>) =>
  new SpinnerRenderable(renderer, {
    frames: spinnerDef.frames,
    color: spinnerDef.colors,
    interval: 40,
  });

export function createAllViews(renderer: Renderer): Views {
  const spinnerDef = createSpinnerDef();

  // Main container
  const container = new BoxRenderable(renderer, {
    id: "container",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  // --- Loading view ---
  const loadingContainer = createViewContainer(renderer, "loading-container", true);
  const loadingSpinner = createSpinner(renderer, spinnerDef);
  const loadingText = new TextRenderable(renderer, {
    id: "loading-text",
    content: "Starting server...",
    fg: COLORS.primary,
  });
  const loadingRow = new BoxRenderable(renderer, { id: "loading-row", flexDirection: "row", gap: 1 });
  loadingRow.add(loadingSpinner);
  loadingRow.add(loadingText);
  loadingContainer.add(loadingRow);

  // --- Provider select view ---
  const providerSelectContainer = createViewContainer(renderer, "provider-select-container");
  const providerLabel = new TextRenderable(renderer, { id: "provider-label", content: ":> Connect a provider", fg: COLORS.primary });
  const providerSelect = new SelectRenderable(renderer, {
    id: "provider-select",
    options: [
      ...PROVIDER_OPTIONS.map(opt => ({ name: opt.name, description: opt.description, value: opt.id })),
      { name: "Skip", description: "(Continue without auth)", value: "skip" },
    ],
    width: 50,
    height: 5,
    ...SELECT_STYLE,
  });
  const providerHelpText = new TextRenderable(renderer, { id: "provider-help", content: "Use \u2191/\u2193 to select, Enter to confirm", fg: COLORS.textMuted });
  providerSelectContainer.add(providerLabel);
  providerSelectContainer.add(providerSelect);
  providerSelectContainer.add(providerHelpText);

  // --- Auth method view ---
  const authMethodContainer = createViewContainer(renderer, "auth-method-container");
  const authMethodLabel = new TextRenderable(renderer, { id: "auth-method-label", content: ":> Select auth method", fg: COLORS.primary });
  const authMethodSelect = new SelectRenderable(renderer, { id: "auth-method-select", options: [], width: 50, height: 4, ...SELECT_STYLE });
  const authMethodHelpText = new TextRenderable(renderer, { id: "auth-method-help", content: "Use \u2191/\u2193 to select, Enter to confirm, Esc to go back", fg: COLORS.textMuted });
  authMethodContainer.add(authMethodLabel);
  authMethodContainer.add(authMethodSelect);
  authMethodContainer.add(authMethodHelpText);

  // --- OAuth auto view ---
  const oauthAutoContainer = createViewContainer(renderer, "oauth-auto-container");
  const oauthAutoLabel = new TextRenderable(renderer, { id: "oauth-auto-label", content: ":> Authenticate", fg: COLORS.primary });
  const oauthUrlText = new TextRenderable(renderer, { id: "oauth-url", content: "", fg: COLORS.primary });
  const oauthInstructionsText = new TextRenderable(renderer, { id: "oauth-instructions", content: "", fg: COLORS.textMuted });
  const oauthAutoSpinner = createSpinner(renderer, spinnerDef);
  const oauthWaitingText = new TextRenderable(renderer, { id: "oauth-waiting", content: "Waiting for authorization...", fg: COLORS.textMuted });
  const oauthWaitingRow = new BoxRenderable(renderer, { id: "oauth-waiting-row", flexDirection: "row", gap: 1 });
  oauthWaitingRow.add(oauthAutoSpinner);
  oauthWaitingRow.add(oauthWaitingText);
  const oauthAutoEscText = new TextRenderable(renderer, { id: "oauth-auto-esc", content: "Press Esc to cancel", fg: COLORS.textMuted });
  oauthAutoContainer.add(oauthAutoLabel);
  oauthAutoContainer.add(oauthUrlText);
  oauthAutoContainer.add(oauthInstructionsText);
  oauthAutoContainer.add(oauthWaitingRow);
  oauthAutoContainer.add(oauthAutoEscText);

  // --- OAuth code view ---
  const oauthCodeContainer = createViewContainer(renderer, "oauth-code-container");
  const oauthCodeLabel = new TextRenderable(renderer, { id: "oauth-code-label", content: ":> Enter authorization code", fg: COLORS.primary });
  const oauthCodeUrlText = new TextRenderable(renderer, { id: "oauth-code-url", content: "", fg: COLORS.primary });
  const oauthCodeInstructionsText = new TextRenderable(renderer, { id: "oauth-code-instructions", content: "", fg: COLORS.textMuted });
  const codeInput = new InputRenderable(renderer, { id: "code-input", width: 40, placeholder: "Authorization code", ...INPUT_STYLE });
  const codeErrorText = new TextRenderable(renderer, { id: "code-error", content: "Invalid code", fg: COLORS.toolError, visible: false });
  const oauthCodeHelpText = new TextRenderable(renderer, { id: "oauth-code-help", content: "Press Enter to submit, Esc to go back", fg: COLORS.textMuted });
  oauthCodeContainer.add(oauthCodeLabel);
  oauthCodeContainer.add(oauthCodeUrlText);
  oauthCodeContainer.add(oauthCodeInstructionsText);
  oauthCodeContainer.add(codeInput);
  oauthCodeContainer.add(codeErrorText);
  oauthCodeContainer.add(oauthCodeHelpText);

  // --- API key view ---
  const apiKeyContainer = createViewContainer(renderer, "api-key-container");
  const apiKeyLabel = new TextRenderable(renderer, { id: "api-key-label", content: ":> Enter API key", fg: COLORS.primary });
  const apiKeyInput = new InputRenderable(renderer, { id: "api-key-input", width: 60, placeholder: "API key", ...INPUT_STYLE });
  const apiKeyErrorText = new TextRenderable(renderer, { id: "api-key-error", content: "Invalid API key", fg: COLORS.toolError, visible: false });
  const apiKeyHelpText = new TextRenderable(renderer, { id: "api-key-help", content: "Press Enter to submit, Esc to go back", fg: COLORS.textMuted });
  apiKeyContainer.add(apiKeyLabel);
  apiKeyContainer.add(apiKeyInput);
  apiKeyContainer.add(apiKeyErrorText);
  apiKeyContainer.add(apiKeyHelpText);

  // --- Model select view ---
  const modelSelectContainer = createViewContainer(renderer, "model-select-container");
  const modelSelectLabel = new TextRenderable(renderer, { id: "model-select-label", content: ":> Select a model", fg: COLORS.primary });
  const modelSelect = new SelectRenderable(renderer, { id: "model-select", options: [], width: 50, height: 8, ...SELECT_STYLE });
  const modelSelectHelpText = new TextRenderable(renderer, { id: "model-select-help", content: "Use \u2191/\u2193 to select, Enter to confirm", fg: COLORS.textMuted });
  modelSelectContainer.add(modelSelectLabel);
  modelSelectContainer.add(modelSelect);
  modelSelectContainer.add(modelSelectHelpText);

  // --- Intent view ---
  const intentContainer = createViewContainer(renderer, "intent-container");
  const intentLabel = new TextRenderable(renderer, { id: "intent-label", content: ":> What are you going to use nightshift for?", fg: COLORS.primary });
  const intentInput = new InputRenderable(renderer, { id: "intent-input", width: 60, placeholder: "e.g., managing my personal finances, analyzing data...", ...INPUT_STYLE });
  const intentHelpText = new TextRenderable(renderer, { id: "intent-help", content: "Press Enter to submit, Ctrl+C to skip", fg: COLORS.textMuted });
  intentContainer.add(intentLabel);
  intentContainer.add(intentInput);
  intentContainer.add(intentHelpText);

  // --- Question view ---
  const questionContainer = createViewContainer(renderer, "question-container");
  const questionHeaderText = new TextRenderable(renderer, { id: "question-header", content: "", fg: COLORS.textMuted });
  const questionLabel = new TextRenderable(renderer, { id: "question-label", content: "", fg: COLORS.primary });
  const questionSelect = new SelectRenderable(renderer, { id: "question-select", options: [], width: 60, height: 6, ...SELECT_STYLE });
  const questionCustomInput = new InputRenderable(renderer, { id: "question-custom-input", width: 60, placeholder: "Type your answer...", visible: false, ...INPUT_STYLE });
  const questionHelpText = new TextRenderable(renderer, { id: "question-help", content: "Use \u2191/\u2193 to select, Enter to confirm, or type a custom answer", fg: COLORS.textMuted });
  questionContainer.add(questionHeaderText);
  questionContainer.add(questionLabel);
  questionContainer.add(questionSelect);
  questionContainer.add(questionCustomInput);
  questionContainer.add(questionHelpText);

  // --- Output view ---
  const outputContainer = new BoxRenderable(renderer, { id: "output-container", flexDirection: "column", flexGrow: 1, padding: 1, visible: false });
  const statusContainer = new BoxRenderable(renderer, { id: "status-container", flexDirection: "row", gap: 1, height: 1 });
  const spinner = createSpinner(renderer, spinnerDef);
  const statusText = new TextRenderable(renderer, { id: "status", content: "Bootstrapping...", fg: COLORS.primary });
  statusContainer.add(spinner);
  statusContainer.add(statusText);
  const contentBox = new BoxRenderable(renderer, { id: "content-box", flexDirection: "column", flexGrow: 1 });
  const scrollBox = new ScrollBoxRenderable(renderer, { id: "scroll", flexGrow: 1, width: "100%", stickyScroll: true, stickyStart: "bottom" });
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

  // View container map for showView
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

  return {
    container,
    loadingContainer,
    loadingText,
    providerSelectContainer,
    providerSelect,
    authMethodContainer,
    authMethodSelect,
    oauthAutoContainer,
    oauthUrlText,
    oauthInstructionsText,
    oauthWaitingText,
    oauthCodeContainer,
    oauthCodeUrlText,
    oauthCodeInstructionsText,
    codeInput,
    codeErrorText,
    apiKeyContainer,
    apiKeyInput,
    apiKeyErrorText,
    modelSelectContainer,
    modelSelect,
    intentContainer,
    intentInput,
    questionContainer,
    questionHeaderText,
    questionLabel,
    questionSelect,
    questionCustomInput,
    questionHelpText,
    outputContainer,
    spinner,
    statusText,
    scrollBox,
    viewContainers,
  };
}
