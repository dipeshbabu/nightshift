import {
  TextRenderable,
  BoxRenderable,
  ScrollBoxRenderable,
  DiffRenderable,
} from "@opentui/core";
import { SpinnerRenderable } from "opentui-spinner";
import stripAnsi from "strip-ansi";
import { COLORS, syntaxStyle, TOOL_STATUS_CONFIG, DIFF_COLORS } from "../../lib/theme";
import { createOutputBlock, addExpandableContent } from "../../lib/output";
import { toUnifiedDiff } from "../../lib/diff";
import { getFiletype } from "../../lib/language";
import type { BootstrapUI, BootstrapState, QuestionAnswer, ViewState } from "./types";
import type { FileDiff } from "../../lib/diff";
import type { Views } from "./views";

type Renderer = ConstructorParameters<typeof BoxRenderable>[0];

export function createBootstrapUI(
  renderer: Renderer,
  views: Views,
  state: BootstrapState,
): BootstrapUI {
  const { scrollBox, spinner, statusText } = views;

  const resetTextTracking = () => {
    state.currentTextNode = null;
    state.currentTextContent = "";
  };

  return {
    appendText: (text: string) => {
      if (!text) return;
      if (state.currentTextNode) {
        state.currentTextContent += text;
        state.currentTextNode.content = state.currentTextContent;
      } else {
        state.currentTextContent = text;
        state.currentTextNode = new TextRenderable(renderer, {
          id: `output-${state.outputCounter++}`,
          content: state.currentTextContent,
          fg: COLORS.text,
          wrapMode: "word",
        });
        scrollBox.add(state.currentTextNode);
      }
    },
    appendToolStatus: (status: "running" | "completed" | "error", text: string) => {
      resetTextTracking();
      const { prefix, color } = TOOL_STATUS_CONFIG[status];
      const statusNode = new TextRenderable(renderer, {
        id: `status-${state.outputCounter++}`,
        content: `${prefix} ${text}`,
        fg: color,
      });
      scrollBox.add(statusNode);
    },
    setStatus: (status: string) => {
      statusText.content = status;
    },
    showDiff: (diffs: FileDiff[]) => {
      resetTextTracking();

      for (const diff of diffs) {
        const headerNode = new TextRenderable(renderer, {
          id: `diff-header-${state.outputCounter++}`,
          content: `\n\u{1F4C4} ${diff.file} (+${diff.additions} -${diff.deletions})`,
          fg: COLORS.text,
        });
        scrollBox.add(headerNode);

        const unifiedDiff = toUnifiedDiff(diff);
        const filetype = getFiletype(diff.file);

        const diffRenderable = new DiffRenderable(renderer, {
          id: `diff-${state.outputCounter++}`,
          diff: unifiedDiff,
          view: "unified",
          syntaxStyle,
          filetype,
          showLineNumbers: true,
          ...DIFF_COLORS,
          width: "100%",
          height: Math.min(diff.additions + diff.deletions + 4, 20),
        });

        scrollBox.add(diffRenderable);
      }
    },
    showBashOutput: (command: string, output: string, description?: string) => {
      resetTextTracking();
      const blockId = `bash-${state.outputCounter++}`;
      const cleanOutput = stripAnsi(output.trim());
      const lines = cleanOutput.split("\n");

      const blockBox = createOutputBlock(renderer, blockId);

      const titleText = new TextRenderable(renderer, {
        id: `${blockId}-title`,
        content: description ? `# ${description}` : "# Shell",
        fg: COLORS.textMuted,
      });

      const commandText = new TextRenderable(renderer, {
        id: `${blockId}-cmd`,
        content: `$ ${command}`,
        fg: COLORS.text,
      });

      blockBox.add(titleText);
      blockBox.add(commandText);

      if (cleanOutput) {
        addExpandableContent(renderer, blockBox, blockId, cleanOutput, lines);
      }

      scrollBox.add(blockBox);
    },
    showWriteOutput: (filePath: string, content: string) => {
      resetTextTracking();
      const blockId = `write-${state.outputCounter++}`;
      const blockBox = createOutputBlock(renderer, blockId);

      const titleText = new TextRenderable(renderer, {
        id: `${blockId}-title`,
        content: `# Wrote ${filePath}`,
        fg: COLORS.textMuted,
      });

      blockBox.add(titleText);

      if (content && content.trim()) {
        const lines = content.split("\n");
        addExpandableContent(renderer, blockBox, blockId, content, lines);
      }

      scrollBox.add(blockBox);
    },
    showEditOutput: (filePath: string, diff: string) => {
      resetTextTracking();
      const blockId = `edit-${state.outputCounter++}`;
      const blockBox = createOutputBlock(renderer, blockId);

      const titleText = new TextRenderable(renderer, {
        id: `${blockId}-title`,
        content: `\u2190 Edit ${filePath}`,
        fg: COLORS.textMuted,
      });

      blockBox.add(titleText);

      if (diff && diff.trim()) {
        const diffRenderable = new DiffRenderable(renderer, {
          id: `${blockId}-diff`,
          diff: diff,
          view: "unified",
          syntaxStyle,
          filetype: getFiletype(filePath),
          showLineNumbers: true,
          ...DIFF_COLORS,
          width: "100%",
        });
        blockBox.add(diffRenderable);
      }

      scrollBox.add(blockBox);
    },
    setSpinnerActive: (active: boolean) => {
      spinner.visible = active;
    },
    showQuestion: (request) => {
      return new Promise((resolve, reject) => {
        const currentQuestionIndex = 0;
        const answers: QuestionAnswer[] = [];
        const question = request.questions[currentQuestionIndex];

        views.questionHeaderText.content = question.header;
        views.questionLabel.content = `:> ${question.question}`;

        const allowCustom = question.custom !== false;
        type QuestionSelectValue = { type: "option" | "custom"; index: number; label: string };
        const selectOptions: Array<{ name: string; description: string; value: QuestionSelectValue }> = question.options.map((opt, idx) => ({
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
        views.questionHelpText.content = "Use \u2191/\u2193 to select, Enter to confirm";

        state.viewState = {
          type: "question",
          request,
          resolve,
          reject,
          currentQuestionIndex,
          answers,
          customInputActive: false,
          selectedIndex: 0,
        };
        showView(views, "question");
        views.questionSelect.focus();
      });
    },
  };
}

export function showView(views: Views, view: ViewState["type"]) {
  for (const [type, container] of Object.entries(views.viewContainers)) {
    container.visible = type === view;
  }
}
