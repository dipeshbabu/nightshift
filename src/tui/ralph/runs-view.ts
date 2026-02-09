import {
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { SpinnerRenderable } from "opentui-spinner";
import type { Job } from "./state";

export interface RunsViewCallbacks {
  onViewRun: (runId: string) => void;
  onBack: () => void;
}

export interface RunsViewHandle {
  mount: () => void;
  unmount: () => void;
  refresh: () => void;
}

const STATUS_ICONS: Record<string, string> = {
  running: "[*]",
  completed: "[+]",
  error: "[!]",
};

export function createRunsView(
  renderer: CliRenderer,
  job: Job,
  callbacks: RunsViewCallbacks,
): RunsViewHandle {
  const promptPreview = job.prompt.length > 50
    ? job.prompt.slice(0, 50) + "..."
    : job.prompt;

  const root = new BoxRenderable(renderer, {
    id: "runs-view-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  // Header
  const header = new BoxRenderable(renderer, {
    id: "runs-view-header",
    height: 3,
    border: true,
    borderStyle: "rounded",
    flexDirection: "row",
    title: " Runs ",
  });
  const spinner = new SpinnerRenderable(renderer, { autoplay: false });
  const headerText = new TextRenderable(renderer, {
    id: "runs-view-header-text",
    content: ` ${promptPreview}`,
  });
  header.add(spinner);
  header.add(headerText);

  // Run list
  const listBox = new BoxRenderable(renderer, {
    id: "runs-view-list-box",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
  });
  const runList = new SelectRenderable(renderer, {
    id: "runs-view-list",
    flexGrow: 1,
    options: [],
    showDescription: true,
  });
  listBox.add(runList);

  // Footer
  const footer = new BoxRenderable(renderer, {
    id: "runs-view-footer",
    height: 3,
    border: true,
    borderStyle: "rounded",
  });
  const helpText = new TextRenderable(renderer, {
    id: "runs-view-help",
    content: "[Enter] view run  [Esc] back",
  });
  footer.add(helpText);

  root.add(header);
  root.add(listBox);
  root.add(footer);

  function deriveOptions() {
    // Newest first
    const reversed = [...job.runIds].reverse();
    return reversed.map((runId, i) => {
      const runIndex = job.runIds.length - i;
      const isActive = runId === job.runId;
      let icon: string;
      if (isActive) {
        icon = STATUS_ICONS[job.status] ?? "[+]";
      } else {
        icon = "[+]"; // older runs are completed
      }
      return {
        name: `${icon} Run #${runIndex}`,
        description: runId.slice(0, 8),
        value: runId,
      };
    });
  }

  function refresh() {
    runList.options = deriveOptions();
    const isRunning = job.status === "running";
    if (isRunning) {
      spinner.start();
    } else {
      spinner.stop();
    }
  }

  function onItemSelected() {
    const opt = runList.getSelectedOption();
    if (opt) callbacks.onViewRun(opt.value);
  }

  function onKeypress(key: KeyEvent) {
    if (key.name === "escape") {
      callbacks.onBack();
    }
  }

  return {
    mount() {
      renderer.root.add(root);
      runList.focus();
      refresh();
      renderer.keyInput.on("keypress", onKeypress);
      runList.on(SelectRenderableEvents.ITEM_SELECTED, onItemSelected);
    },
    unmount() {
      renderer.keyInput.removeListener("keypress", onKeypress);
      runList.removeListener(SelectRenderableEvents.ITEM_SELECTED, onItemSelected);
      renderer.root.remove("runs-view-root");
    },
    refresh,
  };
}
