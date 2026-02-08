import {
  createCliRenderer,
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  InputRenderableEvents,
  type KeyEvent,
} from "@opentui/core";
import { OutputBuffer } from "./output";
import { streamEvents } from "./stream";

export async function ralphTui(opts: { serverUrl: string }) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });

  const root = new BoxRenderable(renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  const output = new ScrollBoxRenderable(renderer, {
    id: "output",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    title: " nightshift ",
    stickyScroll: true,
  });

  const inputBar = new BoxRenderable(renderer, {
    id: "input-bar",
    height: 3,
    border: true,
    borderStyle: "rounded",
    title: " prompt ",
  });
  const input = new InputRenderable(renderer, {
    id: "input",
    placeholder: "Type a prompt and press Enter...",
    flexGrow: 1,
  });
  inputBar.add(input);

  root.add(output);
  root.add(inputBar);
  renderer.root.add(root);
  input.focus();

  const buf = new OutputBuffer(renderer, output);
  let running = false;
  let pastedPrompt: string | null = null;

  function resetInput() {
    running = false;
    input.focus();
    inputBar.title = " prompt ";
  }

  async function submit(prompt: string) {
    if (running || !prompt.trim()) return;
    running = true;
    input.blur();
    inputBar.title = " running... ";

    buf.appendLine(`\n> ${prompt}`);
    buf.appendLine("");

    try {
      const res = await fetch(`${opts.serverUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const { id } = (await res.json()) as { id: string };
      streamEvents(opts.serverUrl, id, buf, { onEnd: resetInput });
    } catch (err) {
      buf.appendLine(`[error] ${err}`);
      resetInput();
    }
  }

  input.onPaste = (event) => {
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
  };

  input.on(InputRenderableEvents.ENTER, () => {
    if (running) return;
    const value = pastedPrompt ?? input.value;
    pastedPrompt = null;
    input.value = "";
    input.placeholder = "Type a prompt and press Enter...";
    submit(value);
  });

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.name === "escape") {
      if (pastedPrompt) {
        pastedPrompt = null;
        input.value = "";
        input.placeholder = "Type a prompt and press Enter...";
        return;
      }
      renderer.destroy();
    }
  });
}
