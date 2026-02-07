import {
  InputRenderableEvents,
  SelectRenderableEvents,
} from "@opentui/core";
import { join } from "path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { BootstrapUI, BootstrapState, BootstrapPromptResult, QuestionAnswer } from "./types";
import type { Views } from "./views";
import { showView } from "./ui";

type Renderer = ConstructorParameters<typeof import("@opentui/core").BoxRenderable>[0];

interface EventDeps {
  renderer: Renderer;
  views: Views;
  state: BootstrapState;
  ui: BootstrapUI;
  auth: {
    goToProviderSelect: () => void;
    goToIntentPrompt: () => void;
    selectProvider: (client: OpencodeClient, providerId: string) => Promise<void>;
    startOAuth: (client: OpencodeClient, providerId: string, methodIndex: number, label: string) => Promise<void>;
    goToApiKeyView: (providerId: string) => void;
    showModelSelection: (client: OpencodeClient, providerId: string) => Promise<void>;
  };
  getClient: () => OpencodeClient;
  onBootstrap: (intent: string, ui: BootstrapUI, client: OpencodeClient, serverUrl: string, model: { providerID: string; modelID: string }) => Promise<void>;
  serverUrl: string;
  xdgEnv: Record<string, string>;
  prefix: string;
  cleanup: (value: BootstrapPromptResult | null) => Promise<void>;
  cleanupWithError: (err: unknown) => void;
  serverProc: ReturnType<typeof Bun.spawn>;
}

// Helper to process current question answer and move to next or complete
function processQuestionAnswer(views: Views, state: BootstrapState, answer: QuestionAnswer) {
  if (state.viewState.type !== "question") return;

  const { request, resolve, currentQuestionIndex, answers } = state.viewState;
  answers.push(answer);

  const nextIndex = currentQuestionIndex + 1;
  if (nextIndex < request.questions.length) {
    const nextQuestion = request.questions[nextIndex];
    views.questionHeaderText.content = nextQuestion.header;
    views.questionLabel.content = `:> ${nextQuestion.question}`;

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

    views.questionSelect.options = selectOptions;
    views.questionSelect.setSelectedIndex(0);
    views.questionSelect.visible = true;
    views.questionCustomInput.visible = false;
    views.questionCustomInput.value = "";
    views.questionHelpText.content = nextQuestion.multiple
      ? "Use \u2191/\u2193 to select, Space to toggle, Enter to confirm"
      : "Use \u2191/\u2193 to select, Enter to confirm";

    state.viewState = {
      ...state.viewState,
      currentQuestionIndex: nextIndex,
      answers,
      customInputActive: false,
      selectedIndex: 0,
    };
    views.questionSelect.focus();
  } else {
    resolve(answers);
    state.viewState = { type: "bootstrap-output" };
    showView(views, "bootstrap-output");
  }
}

export function setupEventHandlers(deps: EventDeps) {
  const { renderer, views, state, ui, auth, getClient, onBootstrap, serverUrl, xdgEnv, prefix, cleanup, cleanupWithError, serverProc } = deps;

  // Handle Ctrl+C globally
  renderer.keyInput.on("key", async (evt) => {
    if (evt.ctrl && evt.name === "c") {
      await cleanup(null);
      return;
    }

    // Handle question navigation and selection with direct keyboard events
    if (state.viewState.type === "question" && !state.viewState.customInputActive) {
      if (evt.name === "up" || evt.name === "k") {
        const total = views.questionSelect.options.length;
        const newIndex = (state.viewState.selectedIndex - 1 + total) % total;
        state.viewState = { ...state.viewState, selectedIndex: newIndex };
        views.questionSelect.setSelectedIndex(newIndex);
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        const total = views.questionSelect.options.length;
        const newIndex = (state.viewState.selectedIndex + 1) % total;
        state.viewState = { ...state.viewState, selectedIndex: newIndex };
        views.questionSelect.setSelectedIndex(newIndex);
        return;
      }
      if (evt.name === "return") {
        const selected = views.questionSelect.getSelectedOption();
        if (!selected) return;

        const value = selected.value as { type: "option" | "custom"; index: number; label: string };
        if (value.type === "custom") {
          state.viewState = { ...state.viewState, customInputActive: true };
          views.questionSelect.visible = false;
          views.questionCustomInput.visible = true;
          views.questionCustomInput.value = "";
          views.questionHelpText.content = "Type your answer and press Enter, or Esc to go back";
          views.questionCustomInput.focus();
        } else {
          processQuestionAnswer(views, state, [value.label]);
        }
        return;
      }
    }

    // Handle escape for going back
    if (evt.name === "escape") {
      if (state.viewState.type === "question") {
        if (state.viewState.customInputActive) {
          state.viewState = { ...state.viewState, customInputActive: false };
          views.questionCustomInput.visible = false;
          views.questionSelect.visible = true;
          const question = state.viewState.request.questions[state.viewState.currentQuestionIndex];
          views.questionHelpText.content = question.multiple
            ? "Use \u2191/\u2193 to select, Space to toggle, Enter to confirm"
            : "Use \u2191/\u2193 to select, Enter to confirm";
          views.questionSelect.focus();
        } else {
          state.viewState.reject(new Error("Question rejected by user"));
          state.viewState = { type: "bootstrap-output" };
          showView(views, "bootstrap-output");
        }
        return;
      }

      const canGoBack = state.viewState.type === "auth-method-select" ||
        state.viewState.type === "oauth-auto" ||
        state.viewState.type === "oauth-code" ||
        state.viewState.type === "api-key" ||
        state.viewState.type === "model-select";

      if (canGoBack) {
        if (state.viewState.type === "oauth-auto") {
          state.oauthAbort?.abort();
        }
        auth.goToProviderSelect();
      }
    }
  });

  // Handle provider selection
  views.providerSelect.on(SelectRenderableEvents.ITEM_SELECTED, async () => {
    const selected = views.providerSelect.getSelectedOption();
    if (!selected) return;

    if (selected.value === "skip") {
      auth.goToIntentPrompt();
    } else {
      await auth.selectProvider(getClient(), selected.value);
    }
  });

  // Handle auth method selection
  views.authMethodSelect.on(SelectRenderableEvents.ITEM_SELECTED, async () => {
    if (state.viewState.type !== "auth-method-select") return;

    const selected = views.authMethodSelect.getSelectedOption();
    if (!selected) return;

    const methodIndex = selected.value as number;
    const method = state.viewState.methods[methodIndex];

    if (method.type === "oauth") {
      await auth.startOAuth(getClient(), state.viewState.providerId, methodIndex, method.label);
    } else {
      auth.goToApiKeyView(state.viewState.providerId);
    }
  });

  // Handle code input Enter
  views.codeInput.on(InputRenderableEvents.ENTER, async () => {
    if (state.viewState.type !== "oauth-code") return;

    const code = views.codeInput.value?.trim();
    if (!code) return;

    const client = getClient();
    const { error } = await client.provider.oauth.callback({
      providerID: state.viewState.providerId,
      method: state.viewState.methodIndex,
      code,
    });

    if (error) {
      views.codeErrorText.visible = true;
      return;
    }

    await client.instance.dispose();
    await auth.showModelSelection(client, state.viewState.providerId);
  });

  // Handle API key input Enter
  views.apiKeyInput.on(InputRenderableEvents.ENTER, async () => {
    if (state.viewState.type !== "api-key") return;

    const key = views.apiKeyInput.value?.trim();
    if (!key) return;

    const client = getClient();
    await client.auth.set({
      providerID: state.viewState.providerId,
      auth: { type: "api", key },
    });

    await client.instance.dispose();
    await auth.showModelSelection(client, state.viewState.providerId);
  });

  // Handle model selection
  views.modelSelect.on(SelectRenderableEvents.ITEM_SELECTED, async () => {
    const selected = views.modelSelect.getSelectedOption();
    if (!selected) return;

    state.selectedModel = selected.value as any;
    auth.goToIntentPrompt();
  });

  // Handle question selection
  views.questionSelect.on(SelectRenderableEvents.ITEM_SELECTED, async () => {
    if (state.viewState.type !== "question") return;

    const selected = views.questionSelect.getSelectedOption();
    if (!selected) return;

    const value = selected.value as { type: "option" | "custom"; index: number; label: string };

    if (value.type === "custom") {
      state.viewState = { ...state.viewState, customInputActive: true };
      views.questionSelect.visible = false;
      views.questionCustomInput.visible = true;
      views.questionCustomInput.value = "";
      views.questionHelpText.content = "Type your answer and press Enter, or Esc to go back";
      views.questionCustomInput.focus();
    } else {
      processQuestionAnswer(views, state, [value.label]);
    }
  });

  // Handle question custom input Enter
  views.questionCustomInput.on(InputRenderableEvents.ENTER, () => {
    if (state.viewState.type !== "question" || !state.viewState.customInputActive) return;

    const customAnswer = views.questionCustomInput.value?.trim();
    if (!customAnswer) return;

    processQuestionAnswer(views, state, [customAnswer]);
  });

  // Handle intent input Enter
  views.intentInput.on(InputRenderableEvents.ENTER, async () => {
    if (state.viewState.type !== "intent-prompt") return;

    const intent = views.intentInput.value?.trim();
    if (!intent || state.resolved) return;

    state.viewState = { type: "bootstrap-output" };
    showView(views, "bootstrap-output");
    ui.setStatus(`Bootstrapping workspace for: ${intent}`);

    const model = state.selectedModel ?? { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" };

    // Save selected model to model.json
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
      console.error("Failed to save model.json:", err);
    }

    const client = getClient();
    try {
      await onBootstrap(intent, ui, client, serverUrl, model);
      views.spinner.visible = false;
      ui.setStatus("\u2713 Bootstrap complete!");
      await new Promise((r) => setTimeout(r, 1000));
      await cleanup({ intent, client, serverUrl, serverProc, model });
    } catch (err) {
      cleanupWithError(err);
    }
  });
}
