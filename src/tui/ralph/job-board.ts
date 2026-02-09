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

export interface JobBoardCallbacks {
  onViewJob: (jobId: string) => void;
  onRunJob: (jobId: string) => void;
  onQuit: () => void;
  onCaffinate: () => void;
  onSwitchToBoots: () => void;
}

export interface JobBoardHandle {
  mount: () => void;
  unmount: () => void;
  refresh: () => void;
}

const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

const STATUS_ICONS: Record<Job["status"], string> = {
  draft: "[ ]",
  running: "[*]",
  completed: "[+]",
  error: "[!]",
  interrupted: "[~]",
};

const LIST_HELP = "[n] new  [e] edit  [r] run  [s] stop  [d] delete  [Enter] view  [b] boot  [c] caffinate  [Esc] quit";
const EDITOR_HELP = "[Ctrl+S] save  [Esc] cancel";

export function createJobBoard(
  renderer: CliRenderer,
  state: AppState,
  client: RalphClient,
  callbacks: JobBoardCallbacks,
): JobBoardHandle {
  const root = new BoxRenderable(renderer, {
    id: "board-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  // Header
  const header = new BoxRenderable(renderer, {
    id: "board-header",
    height: 3,
    border: true,
    borderStyle: "rounded",
    flexDirection: "row",
    title: " nightshift - Job Board ",
  });
  const spinner = new SpinnerRenderable(renderer, {
    autoplay: false,
  });
  header.add(spinner);

  // Job list (wrapped in a box for border)
  const listBox = new BoxRenderable(renderer, {
    id: "board-list-box",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
  });
  const jobList = new SelectRenderable(renderer, {
    id: "board-list",
    flexGrow: 1,
    options: [],
    showDescription: true,
  });
  listBox.add(jobList);

  // Editor area (hidden by default, wrapped in a box for border)
  const editorBox = new BoxRenderable(renderer, {
    id: "board-editor-box",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    title: " editor ",
  });
  const editor = new TextareaRenderable(renderer, {
    id: "board-editor",
    flexGrow: 1,
    placeholder: "Type your prompt here...",
  });
  editorBox.add(editor);

  // Footer
  const footer = new BoxRenderable(renderer, {
    id: "board-footer",
    height: 3,
    border: true,
    borderStyle: "rounded",
  });
  const helpText = new TextRenderable(renderer, {
    id: "board-help",
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
    return state.jobs.map((job) => ({
      name: `${statusIcon(job.status)} ${job.prompt.length > 60 ? job.prompt.slice(0, 60) + "..." : job.prompt}`,
      description: `Created ${new Date(job.createdAt).toLocaleTimeString()}`,
      value: job.id,
    }));
  }

  function startSpinnerTimer() {
    if (spinnerInterval) return;
    spinnerInterval = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      jobList.options = deriveOptions();
    }, 80);
  }

  function stopSpinnerTimer() {
    if (!spinnerInterval) return;
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }

  function refresh() {
    jobList.options = deriveOptions();

    const hasRunning = state.jobs.some((j) => j.status === "running");
    if (hasRunning) {
      spinner.start();
      startSpinnerTimer();
    } else {
      spinner.stop();
      stopSpinnerTimer();
    }

    if (state.boardFocus === "list") {
      helpText.content = LIST_HELP;
    } else {
      helpText.content = EDITOR_HELP;
    }
  }

  function showEditor(jobId: string | null) {
    state.boardFocus = "editor";
    state.editingJobId = jobId;

    // Swap list for editor
    root.remove("board-list-box");
    root.remove("board-footer");
    root.add(editorBox);
    root.add(footer);

    // Defer focus to next tick so the triggering keypress (n/e)
    // doesn't propagate into the textarea
    setTimeout(() => {
      if (jobId) {
        const job = state.jobs.find((j) => j.id === jobId);
        if (job) editor.setText(job.prompt);
      } else {
        editor.setText("");
      }
      editor.focus();
    }, 0);

    refresh();
  }

  function hideEditor() {
    state.boardFocus = "list";
    state.editingJobId = null;

    root.remove("board-editor-box");
    root.remove("board-footer");
    root.add(listBox);
    root.add(footer);

    jobList.focus();
    refresh();
  }

  async function saveEditor() {
    const text = editor.plainText.trim();
    if (!text) {
      hideEditor();
      return;
    }

    if (state.editingJobId) {
      // Update existing job
      const job = state.jobs.find((j) => j.id === state.editingJobId);
      if (job) {
        job.prompt = text;
        await client.updateJob(job.id, { prompt: text });
      }
    } else {
      // Create new job via server
      const job = await client.createJob(text);
      state.jobs.push(job);
    }

    hideEditor();
  }

  let confirmAction: { type: "delete"; jobId: string } | { type: "stop"; jobId: string } | { type: "quit" } | { type: "caffinate" } | null = null;

  function showConfirm(action: typeof confirmAction) {
    confirmAction = action;
    if (action?.type === "delete" || action?.type === "stop") {
      const job = state.jobs.find((j) => j.id === action.jobId);
      if (!job) { confirmAction = null; return; }
      const preview = job.prompt.length > 40 ? job.prompt.slice(0, 40) + "..." : job.prompt;
      const verb = action.type === "delete" ? "Delete" : "Stop";
      helpText.content = t`${red(bold(verb))} ${dim(`"${preview}"`)}? ${bold("y")}/${bold("n")}`;
    } else if (action?.type === "quit") {
      helpText.content = t`Are you sure you want to quit Nightshift? ${bold("y")}/${bold("n")}`;
    } else if (action?.type === "caffinate") {
      helpText.content = t`Caffinate? Jobs will keep running in the background. ${bold("y")}/${bold("n")}`;
    }
  }

  function hideConfirm() {
    confirmAction = null;
    helpText.content = LIST_HELP;
  }

  function getSelectedJobId(): string | null {
    const opt = jobList.getSelectedOption();
    return opt?.value ?? null;
  }

  function onKeypress(key: KeyEvent) {
    // Confirm dialog intercepts all keys
    if (confirmAction) {
      if (key.name === "y") {
        if (confirmAction.type === "delete") {
          const id = confirmAction.jobId;
          client.deleteJob(id);
          state.jobs = state.jobs.filter((j) => j.id !== id);
          hideConfirm();
          refresh();
        } else if (confirmAction.type === "stop") {
          const id = confirmAction.jobId;
          const job = state.jobs.find((j) => j.id === id);
          if (job && job.runId) {
            client.interruptRun(job.runId, "user_stop");
            job.status = "interrupted";
          }
          hideConfirm();
          refresh();
        } else if (confirmAction.type === "quit") {
          hideConfirm();
          callbacks.onQuit();
        } else if (confirmAction.type === "caffinate") {
          hideConfirm();
          callbacks.onCaffinate();
        }
      } else if (key.name === "n" || key.name === "escape") {
        hideConfirm();
      }
      return;
    }

    if (state.boardFocus === "editor") {
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
    if (key.name === "b") {
      callbacks.onSwitchToBoots();
      return;
    }

    if (key.name === "n") {
      showEditor(null);
      return;
    }

    if (key.name === "e") {
      const id = getSelectedJobId();
      if (id) showEditor(id);
      return;
    }

    if (key.name === "r") {
      const id = getSelectedJobId();
      if (id) callbacks.onRunJob(id);
      return;
    }

    if (key.name === "s") {
      const id = getSelectedJobId();
      if (!id) return;
      const job = state.jobs.find((j) => j.id === id);
      if (job && job.status === "running" && job.runId) {
        showConfirm({ type: "stop", jobId: id });
      }
      return;
    }

    if (key.name === "d") {
      const id = getSelectedJobId();
      if (id) showConfirm({ type: "delete", jobId: id });
      return;
    }

    if (key.name === "c") {
      if (state.jobs.some((j) => j.status === "running")) {
        showConfirm({ type: "caffinate" });
      }
      return;
    }

    if (key.name === "escape") {
      showConfirm({ type: "quit" });
      return;
    }
  }

  function onItemSelected() {
    const id = getSelectedJobId();
    if (id) callbacks.onViewJob(id);
  }

  return {
    mount() {
      renderer.root.add(root);
      jobList.focus();
      refresh();
      renderer.keyInput.on("keypress", onKeypress);
      jobList.on(SelectRenderableEvents.ITEM_SELECTED, onItemSelected);
    },
    unmount() {
      stopSpinnerTimer();
      renderer.keyInput.removeListener("keypress", onKeypress);
      jobList.removeListener(SelectRenderableEvents.ITEM_SELECTED, onItemSelected);
      renderer.root.remove("board-root");
    },
    refresh,
  };
}
