import open from "open";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { BootstrapState, ModelOption } from "./types";
import type { Views } from "./views";
import { showView } from "./ui";

export function createAuthHandlers(views: Views, state: BootstrapState) {
  const goToProviderSelect = () => {
    state.viewState = { type: "provider-select", selectedIndex: 0 };
    showView(views, "provider-select");
    views.providerSelect.setSelectedIndex(0);
    views.providerSelect.focus();
  };

  const goToIntentPrompt = () => {
    state.viewState = { type: "intent-prompt" };
    showView(views, "intent-prompt");
    views.intentInput.focus();
  };

  const goToApiKeyView = (providerId: string) => {
    state.viewState = { type: "api-key", providerId };
    showView(views, "api-key");
    views.apiKeyInput.focus();
    views.apiKeyInput.value = "";
    views.apiKeyErrorText.visible = false;
  };

  const showLoading = (message: string) => {
    views.loadingText.content = message;
    state.viewState = { type: "loading" };
    showView(views, "loading");
  };

  const setAuthMethodOptions = (methods: Array<{ type: string; label: string }>) => {
    views.authMethodSelect.options = methods.map((method, index) => ({
      name: method.label,
      description: method.type === "oauth" ? "Browser login" : "Enter key",
      value: index,
    }));
    views.authMethodSelect.setSelectedIndex(0);
  };

  const showModelSelection = async (client: OpencodeClient, providerId: string) => {
    showLoading("Fetching available models...");

    try {
      const providersResp = await client.config.providers();
      const providers = providersResp.data?.providers ?? [];

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

      views.modelSelect.options = models.map((m) => ({
        name: m.modelID,
        description: m.name !== m.modelID ? m.name : m.providerID,
        value: m,
      }));
      views.modelSelect.setSelectedIndex(0);

      state.viewState = { type: "model-select", models };
      showView(views, "model-select");
      views.modelSelect.focus();
    } catch (err) {
      goToIntentPrompt();
    }
  };

  const startOAuthAuto = async (client: OpencodeClient, providerId: string, methodIndex: number) => {
    state.oauthAbort = new AbortController();

    try {
      const result = await client.provider.oauth.callback({
        providerID: providerId,
        method: methodIndex,
      });

      if (state.oauthAbort.signal.aborted) return;

      if (result.error) {
        goToProviderSelect();
        return;
      }

      await client.instance.dispose();
      await showModelSelection(client, providerId);
    } catch (err) {
      if (state.oauthAbort.signal.aborted) return;
      goToProviderSelect();
    }
  };

  const startOAuth = async (client: OpencodeClient, providerId: string, methodIndex: number, label: string) => {
    const result = await client.provider.oauth.authorize({
      providerID: providerId,
      method: methodIndex,
    });

    if (!result.data) {
      goToProviderSelect();
      return;
    }

    const { url, method, instructions } = result.data;

    open(url).catch(() => {
      // Ignore errors - user can still manually click the URL
    });

    if (method === "code") {
      state.viewState = { type: "oauth-code", providerId, methodIndex, url, instructions };
      showView(views, "oauth-code");
      views.oauthCodeUrlText.content = url;
      views.oauthCodeInstructionsText.content = instructions;
      views.codeInput.focus();
      views.codeInput.value = "";
      views.codeErrorText.visible = false;
    } else {
      state.viewState = { type: "oauth-auto", providerId, methodIndex, url, instructions };
      showView(views, "oauth-auto");
      views.oauthUrlText.content = url;
      views.oauthInstructionsText.content = instructions;

      startOAuthAuto(client, providerId, methodIndex);
    }
  };

  const selectProvider = async (client: OpencodeClient, providerId: string) => {
    showLoading("Fetching auth methods...");

    const authResponse = await client.provider.auth();
    const methods = authResponse.data?.[providerId] ?? [{ type: "api", label: "API key" }];

    if (methods.length === 1) {
      const method = methods[0];
      if (method.type === "oauth") {
        await startOAuth(client, providerId, 0, method.label);
      } else {
        goToApiKeyView(providerId);
      }
    } else {
      state.viewState = { type: "auth-method-select", providerId, methods, selectedIndex: 0 };
      showView(views, "auth-method-select");
      setAuthMethodOptions(methods);
      views.authMethodSelect.focus();
    }
  };

  return {
    goToProviderSelect,
    goToIntentPrompt,
    goToApiKeyView,
    showLoading,
    setAuthMethodOptions,
    showModelSelection,
    startOAuthAuto,
    startOAuth,
    selectProvider,
  };
}
