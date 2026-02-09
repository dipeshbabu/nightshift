import {
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { SpinnerRenderable } from "opentui-spinner";
import type { Job, RunStatus } from "./state";
import type { RalphClient } from "./client";

export interface BootRunsViewCallbacks {
  onViewRun: (runId: string) => void;
  onBack: () => void;
}

export interface BootRunsViewHandle {
  mount: () => void;
  unmount: () => void;
  refresh: () => void;
}

const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

const RUN_STATUS_ICONS: Record<RunStatus, string> = {
  running: "[*]",
  completed: "[+]",
  error: "[!]",
  interrupted: "[~]",
  unknown: "[?]",
};

export function createBootRunsView(
  renderer: CliRenderer,
  job: Job,
  client: RalphClient,
  callbacks: BootRunsViewCallbacks,
): BootRunsViewHandle {
  const promptPreview = job.prompt.length > 50
    ? job.prompt.slice(0, 50) + "..."
    : job.prompt;

  const root = new BoxRenderable(renderer, {
    id: "boot-runs-view-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  // Header
  const header = new BoxRenderable(renderer, {
    id: "boot-runs-view-header",
    height: 3,
    border: true,
    borderStyle: "rounded",
    flexDirection: "row",
    title: " Boot Runs ",
  });
  const spinner = new SpinnerRenderable(renderer, { autoplay: false });
  const headerText = new TextRenderable(renderer, {
    id: "boot-runs-view-header-text",
    content: ` ${promptPreview}`,
  });
  header.add(spinner);
  header.add(headerText);

  // Run list
  const listBox = new BoxRenderable(renderer, {
    id: "boot-runs-view-list-box",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
  });
  const runList = new SelectRenderable(renderer, {
    id: "boot-runs-view-list",
    flexGrow: 1,
    options: [],
    showDescription: true,
  });
  listBox.add(runList);

  // Footer
  const footer = new BoxRenderable(renderer, {
    id: "boot-runs-view-footer",
    height: 3,
    border: true,
    borderStyle: "rounded",
  });
  const helpText = new TextRenderable(renderer, {
    id: "boot-runs-view-help",
    content: "[Enter] view run  [Esc] back",
  });
  footer.add(helpText);

  root.add(header);
  root.add(listBox);
  root.add(footer);

  // Per-run statuses fetched from server
  let runStatuses: Record<string, RunStatus> = {};
  let spinnerFrame = 0;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;

  function deriveOptions() {
    // Newest first
    const reversed = [...job.runIds].reverse();
    return reversed.map((runId, i) => {
      const runIndex = job.runIds.length - i;
      const isActive = runId === job.runId && job.status === "running";
      const icon = isActive
        ? `[${SPINNER_FRAMES[spinnerFrame]}]`
        : RUN_STATUS_ICONS[runStatuses[runId] ?? "unknown"];
      return {
        name: `${icon} Run #${runIndex}`,
        description: runId.slice(0, 8),
        value: runId,
      };
    });
  }

  function startSpinnerTimer() {
    if (spinnerInterval) return;
    spinnerInterval = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      runList.options = deriveOptions();
    }, 80);
  }

  function stopSpinnerTimer() {
    if (!spinnerInterval) return;
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }

  function refresh() {
    runList.options = deriveOptions();
    const isActive = job.status === "running";
    if (isActive) {
      spinner.start();
      startSpinnerTimer();
    } else {
      spinner.stop();
      stopSpinnerTimer();
    }
  }

  async function fetchStatuses() {
    if (job.runIds.length === 0) return;
    try {
      runStatuses = await client.getRunStatuses(job.runIds);
    } catch {}
    refresh();
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
      fetchStatuses();
    },
    unmount() {
      stopSpinnerTimer();
      renderer.keyInput.removeListener("keypress", onKeypress);
      runList.removeListener(SelectRenderableEvents.ITEM_SELECTED, onItemSelected);
      renderer.root.remove("boot-runs-view-root");
    },
    refresh,
  };
}
