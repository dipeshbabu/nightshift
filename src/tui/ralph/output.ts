import { TextRenderable, type ScrollBoxRenderable, type CliRenderer } from "@opentui/core";

export class OutputBuffer {
  private lineCount = 0;
  private currentTextLine: TextRenderable | null = null;
  private currentText = "";

  constructor(
    private renderer: CliRenderer,
    private output: ScrollBoxRenderable,
  ) {}

  appendLine(text: string) {
    const line = new TextRenderable(this.renderer, {
      id: `line-${this.lineCount++}`,
      content: text,
    });
    this.output.add(line);
  }

  flush() {
    if (this.currentText) {
      this.appendLine(this.currentText);
      this.currentTextLine = null;
      this.currentText = "";
    }
  }

  appendTextDelta(delta: string) {
    this.currentText += delta;

    // Flush completed lines on newlines
    if (this.currentText.includes("\n")) {
      const parts = this.currentText.split("\n");
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i]) {
          if (this.currentTextLine) {
            this.currentTextLine.content = parts[i];
            this.currentTextLine = null;
          } else {
            this.appendLine(parts[i]);
          }
        }
      }
      this.currentText = parts[parts.length - 1];
      this.currentTextLine = null;
    }

    // Update or create the in-progress text line
    if (this.currentText) {
      if (this.currentTextLine) {
        this.currentTextLine.content = this.currentText;
      } else {
        this.currentTextLine = new TextRenderable(this.renderer, {
          id: `line-${this.lineCount++}`,
          content: this.currentText,
        });
        this.output.add(this.currentTextLine);
      }
    }
  }
}
