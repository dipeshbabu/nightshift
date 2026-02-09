import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  InputRenderableEvents,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { OutputBuffer } from "./output";
import { streamEvents, renderEvent, type StreamHandle } from "./stream";
import type { RalphEvent } from "../../cli/agents/events";
import type { Job } from "./state";

export interface JobViewCallbacks {
  onBack: () => void;
  onJobStatusChange: (jobId: string, status: "running" | "completed" | "error", runId?: string) => void;
}

export interface JobViewHandle {
  mount: () => void;
  unmount: () => void;
  startStreaming: (runId: string) => void;
}

export function createJobView(
  renderer: CliRenderer,
  serverUrl: string,
  job: Job,
  callbacks: JobViewCallbacks,
): JobViewHandle {
  const promptPreview = job.prompt.length > 40
    ? job.prompt.slice(0, 40) + "..."
    : job.prompt;

  const root = new BoxRenderable(renderer, {
    id: "job-view-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  const navBar = new BoxRenderable(renderer, {
    id: "job-view-nav",
    height: 1,
    width: "100%",
  });
  const navText = new TextRenderable(renderer, {
    id: "job-view-nav-text",
    content: `[Esc] Back  |  Job: ${promptPreview}`,
  });
  navBar.add(navText);

  const output = new ScrollBoxRenderable(renderer, {
    id: "job-view-output",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    title: " nightshift ",
    stickyScroll: true,
  });

  const inputBar = new BoxRenderable(renderer, {
    id: "job-view-input-bar",
    height: 3,
    border: true,
    borderStyle: "rounded",
    title: " prompt ",
  });
  const input = new InputRenderable(renderer, {
    id: "job-view-input",
    placeholder: "Type a follow-up prompt and press Enter...",
    flexGrow: 1,
  });
  inputBar.add(input);

  root.add(navBar);
  root.add(output);
  root.add(inputBar);

  const buf = new OutputBuffer(renderer, output);
  let activeStream: StreamHandle | null = null;
  let pastedPrompt: string | null = null;
  let mounted = false;

  function setRunningUI(isRunning: boolean) {
    if (isRunning) {
      input.blur();
      inputBar.title = " running... ";
    } else {
      input.focus();
      inputBar.title = " prompt ";
    }
  }

  function onStreamEnd() {
    if (!mounted) return;
    activeStream = null;
    setRunningUI(false);
  }

  async function submit(prompt: string) {
    if (activeStream || !prompt.trim()) return;
    setRunningUI(true);

    buf.appendLine(`\n> ${prompt}`);
    buf.appendLine("");

    try {
      const res = await fetch(`${serverUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const { id } = (await res.json()) as { id: string };
      callbacks.onJobStatusChange(job.id, "running", id);
      activeStream = streamEvents(serverUrl, id, buf, { onEnd: onStreamEnd });
    } catch (err) {
      buf.appendLine(`[error] ${err}`);
      callbacks.onJobStatusChange(job.id, "error");
      setRunningUI(false);
    }
  }

  function onEnter() {
    if (activeStream) return;
    const value = pastedPrompt ?? input.value;
    pastedPrompt = null;
    input.value = "";
    input.placeholder = "Type a follow-up prompt and press Enter...";
    submit(value);
  }

  function onPaste(event: { preventDefault: () => void; text: string }) {
    event.preventDefault();
    const text = event.text;
    const lines = text.split("\n");

    if (lines.length <= 1) {
      input.insertText(text);
      return;
    }

    pastedPrompt = text;
    input.value = `[Pasted ${lines.length} lines]`;
    input.placeholder = "Press Enter to submit pasted prompt, or Esc to clear";
  }

  function onKeypress(key: KeyEvent) {
    if (key.name === "escape") {
      if (pastedPrompt) {
        pastedPrompt = null;
        input.value = "";
        input.placeholder = "Type a follow-up prompt and press Enter...";
        return;
      }
      callbacks.onBack();
    }
  }

  function beginStreaming(runId: string) {
    if (activeStream) return;
    setRunningUI(true);
    activeStream = streamEvents(serverUrl, runId, buf, { onEnd: onStreamEnd });
  }

  return {
    mount() {
      mounted = true;
      renderer.root.add(root);
      input.on(InputRenderableEvents.ENTER, onEnter);
      input.onPaste = onPaste;
      renderer.keyInput.on("keypress", onKeypress);

      if (job.runId) {
        const runId = job.runId;
        // Immediately reflect known status in UI
        setRunningUI(job.status === "running");

        (async () => {
          let hasTerminal = false;
          try {
            const res = await fetch(`${serverUrl}/runs/${runId}/events`);
            if (res.ok) {
              const events: RalphEvent[] = await res.json();
              for (const event of events) {
                renderEvent(event, buf);
                if (event.type === "ralph.completed" || event.type === "ralph.error") {
                  hasTerminal = true;
                }
              }
              buf.flush();
            }
          } catch {}

          if (!mounted) return;

          if (hasTerminal) {
            setRunningUI(false);
          } else {
            beginStreaming(runId);
          }
        })();
      } else {
        input.focus();
      }
    },
    unmount() {
      mounted = false;
      activeStream?.abort();
      activeStream = null;
      renderer.keyInput.removeListener("keypress", onKeypress);
      input.removeListener(InputRenderableEvents.ENTER, onEnter);
      renderer.root.remove("job-view-root");
    },
    startStreaming(runId: string) {
      beginStreaming(runId);
    },
  };
}
