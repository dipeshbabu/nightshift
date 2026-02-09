import {
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  TextareaRenderable,
  SelectRenderableEvents,
  t, bold, red, dim,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { SpinnerRenderable } from "opentui-spinner";
import { type AppState, type Job } from "./state";
import type { RalphClient } from "./client";

export interface BootBoardCallbacks {
  onViewBoot: (bootId: string) => void;
  onRunBoot: (bootId: string) => void;
  onQuit: () => void;
  onSwitchToJobs: () => void;
}

export interface BootBoardHandle {
  mount: () => void;
  unmount: () => void;
  refresh: () => void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STATUS_ICONS: Record<Job["status"], string> = {
  draft: "[ ]",
  running: "[*]",
  completed: "[+]",
  error: "[!]",
  interrupted: "[~]",
};

const LIST_HELP = "[n] new  [e] edit  [r] run  [s] stop  [d] delete  [Enter] view  [j] jobs  [Esc] quit";
const EDITOR_HELP = "[Ctrl+S] save  [Esc] cancel";

export function createBootBoard(
  renderer: CliRenderer,
  state: AppState,
  client: RalphClient,
  callbacks: BootBoardCallbacks,
): BootBoardHandle {
  const root = new BoxRenderable(renderer, {
    id: "boot-board-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  // Header
  const header = new BoxRenderable(renderer, {
    id: "boot-board-header",
    height: 3,
    border: true,
    borderStyle: "rounded",
    flexDirection: "row",
    title: " nightshift - BOOT PROMPTS",
  });
  const spinner = new SpinnerRenderable(renderer, {
    autoplay: false,
  });
  header.add(spinner);

  // Boot list (wrapped in a box for border)
  const listBox = new BoxRenderable(renderer, {
    id: "boot-board-list-box",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
  });
  const bootList = new SelectRenderable(renderer, {
    id: "boot-board-list",
    flexGrow: 1,
    options: [],
    showDescription: true,
  });
  listBox.add(bootList);

  // Editor area (hidden by default, wrapped in a box for border)
  const editorBox = new BoxRenderable(renderer, {
    id: "boot-board-editor-box",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    title: " editor ",
  });
  const editor = new TextareaRenderable(renderer, {
    id: "boot-board-editor",
    flexGrow: 1,
    placeholder: "Type your prompt here...",
  });
  editorBox.add(editor);

  // Footer
  const footer = new BoxRenderable(renderer, {
    id: "boot-board-footer",
    height: 3,
    border: true,
    borderStyle: "rounded",
  });
  const helpText = new TextRenderable(renderer, {
    id: "boot-board-help",
    content: LIST_HELP,
  });
  footer.add(helpText);

  // Build initial layout
  root.add(header);
  root.add(listBox);
  root.add(footer);

  let spinnerFrame = 0;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;

  function statusIcon(status: Job["status"]) {
    if (status === "running") return `[${SPINNER_FRAMES[spinnerFrame]}]`;
    return STATUS_ICONS[status];
  }

  function deriveOptions() {
    return state.boots.map((boot) => ({
      name: `${statusIcon(boot.status)} ${boot.prompt.length > 60 ? boot.prompt.slice(0, 60) + "..." : boot.prompt}`,
      description: `Created ${new Date(boot.createdAt).toLocaleTimeString()}`,
      value: boot.id,
    }));
  }

  function startSpinnerTimer() {
    if (spinnerInterval) return;
    spinnerInterval = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      bootList.options = deriveOptions();
    }, 80);
  }

  function stopSpinnerTimer() {
    if (!spinnerInterval) return;
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }

  function refresh() {
    bootList.options = deriveOptions();

    const hasRunning = state.boots.some((j) => j.status === "running");
    if (hasRunning) {
      spinner.start();
      startSpinnerTimer();
    } else {
      spinner.stop();
      stopSpinnerTimer();
    }

    if (state.bootBoardFocus === "list") {
      helpText.content = LIST_HELP;
    } else {
      helpText.content = EDITOR_HELP;
    }
  }

  function showEditor(bootId: string | null) {
    state.bootBoardFocus = "editor";
    state.editingBootId = bootId;

    // Swap list for editor
    root.remove("boot-board-list-box");
    root.remove("boot-board-footer");
    root.add(editorBox);
    root.add(footer);

    // Defer focus to next tick so the triggering keypress (n/e)
    // doesn't propagate into the textarea
    setTimeout(() => {
      if (bootId) {
        const boot = state.boots.find((j) => j.id === bootId);
        if (boot) editor.setText(boot.prompt);
      } else {
        editor.setText("");
      }
      editor.focus();
    }, 0);

    refresh();
  }

  function hideEditor() {
    state.bootBoardFocus = "list";
    state.editingBootId = null;

    root.remove("boot-board-editor-box");
    root.remove("boot-board-footer");
    root.add(listBox);
    root.add(footer);

    bootList.focus();
    refresh();
  }

  async function saveEditor() {
    const text = editor.plainText.trim();
    if (!text) {
      hideEditor();
      return;
    }

    if (state.editingBootId) {
      // Update existing boot
      const boot = state.boots.find((j) => j.id === state.editingBootId);
      if (boot) {
        boot.prompt = text;
        await client.updateJob(boot.id, { prompt: text });
      }
    } else {
      // Create new boot via server
      const boot = await client.createJob(text);
      state.boots.push(boot);
    }

    hideEditor();
  }

  let confirmAction: { type: "delete"; bootId: string } | { type: "stop"; bootId: string } | { type: "quit" } | null = null;

  function showConfirm(action: typeof confirmAction) {
    confirmAction = action;
    if (action?.type === "delete" || action?.type === "stop") {
      const boot = state.boots.find((j) => j.id === action.bootId);
      if (!boot) { confirmAction = null; return; }
      const preview = boot.prompt.length > 40 ? boot.prompt.slice(0, 40) + "..." : boot.prompt;
      const verb = action.type === "delete" ? "Delete" : "Stop";
      helpText.content = t`${red(bold(verb))} ${dim(`"${preview}"`)}? ${bold("y")}/${bold("n")}`;
    } else if (action?.type === "quit") {
      helpText.content = t`Are you sure you want to quit Nightshift? ${bold("y")}/${bold("n")}`;
    }
  }

  function hideConfirm() {
    confirmAction = null;
    helpText.content = LIST_HELP;
  }

  function getSelectedBootId(): string | null {
    const opt = bootList.getSelectedOption();
    return opt?.value ?? null;
  }

  function onKeypress(key: KeyEvent) {
    // Confirm dialog intercepts all keys
    if (confirmAction) {
      if (key.name === "y") {
        if (confirmAction.type === "delete") {
          const id = confirmAction.bootId;
          client.deleteJob(id);
          state.boots = state.boots.filter((j) => j.id !== id);
          hideConfirm();
          refresh();
        } else if (confirmAction.type === "stop") {
          const id = confirmAction.bootId;
          const boot = state.boots.find((j) => j.id === id);
          if (boot && boot.runId) {
            client.interruptRun(boot.runId, "user_stop");
            boot.status = "interrupted";
          }
          hideConfirm();
          refresh();
        } else if (confirmAction.type === "quit") {
          hideConfirm();
          callbacks.onQuit();
        }
      } else if (key.name === "n" || key.name === "escape") {
        hideConfirm();
      }
      return;
    }

    if (state.bootBoardFocus === "editor") {
      // Ctrl+S to save
      if (key.name === "s" && key.ctrl) {
        saveEditor();
        return;
      }
      // Ctrl+Enter to save
      if (key.name === "return" && key.ctrl) {
        saveEditor();
        return;
      }
      if (key.name === "escape") {
        hideEditor();
        return;
      }
      return;
    }

    // List mode keybindings
    if (key.name === "j") {
      callbacks.onSwitchToJobs();
      return;
    }

    if (key.name === "n") {
      showEditor(null);
      return;
    }

    if (key.name === "e") {
      const id = getSelectedBootId();
      if (id) showEditor(id);
      return;
    }

    if (key.name === "r") {
      const id = getSelectedBootId();
      if (id) callbacks.onRunBoot(id);
      return;
    }

    if (key.name === "s") {
      const id = getSelectedBootId();
      if (!id) return;
      const boot = state.boots.find((j) => j.id === id);
      if (boot && boot.status === "running" && boot.runId) {
        showConfirm({ type: "stop", bootId: id });
      }
      return;
    }

    if (key.name === "d") {
      const id = getSelectedBootId();
      if (id) showConfirm({ type: "delete", bootId: id });
      return;
    }

    if (key.name === "escape") {
      showConfirm({ type: "quit" });
      return;
    }
  }

  function onItemSelected() {
    const id = getSelectedBootId();
    if (id) callbacks.onViewBoot(id);
  }

  return {
    mount() {
      renderer.root.add(root);
      bootList.focus();
      refresh();
      renderer.keyInput.on("keypress", onKeypress);
      bootList.on(SelectRenderableEvents.ITEM_SELECTED, onItemSelected);
    },
    unmount() {
      stopSpinnerTimer();
      renderer.keyInput.removeListener("keypress", onKeypress);
      bootList.removeListener(SelectRenderableEvents.ITEM_SELECTED, onItemSelected);
      renderer.root.remove("boot-board-root");
    },
    refresh,
  };
}
