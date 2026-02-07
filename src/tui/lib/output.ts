import { TextRenderable, BoxRenderable } from "@opentui/core";
import { COLORS } from "./theme";

type Renderer = ConstructorParameters<typeof BoxRenderable>[0];

/** Create a styled output block box with left border */
export const createOutputBlock = (renderer: Renderer, blockId: string): BoxRenderable => {
  return new BoxRenderable(renderer, {
    id: blockId,
    flexDirection: "column",
    border: ["left"],
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    marginTop: 1,
    gap: 1,
    backgroundColor: COLORS.backgroundPanel,
    borderColor: COLORS.background,
  });
};

/** Add expandable text content to a block with "click to expand" functionality */
export const addExpandableContent = (
  renderer: Renderer,
  blockBox: BoxRenderable,
  blockId: string,
  content: string,
  lines: string[],
) => {
  const truncated = lines.length > 10;
  let expanded = false;

  const contentText = new TextRenderable(renderer, {
    id: `${blockId}-content`,
    content: truncated ? lines.slice(0, 10).join("\n") : content,
    fg: COLORS.text,
    wrapMode: "word",
  });
  blockBox.add(contentText);

  if (truncated) {
    const moreText = new TextRenderable(renderer, {
      id: `${blockId}-more`,
      content: `... (${lines.length - 10} more lines) - click to expand`,
      fg: COLORS.textMuted,
      onMouseUp: () => {
        expanded = !expanded;
        contentText.content = expanded ? content : lines.slice(0, 10).join("\n");
        moreText.content = expanded
          ? "click to collapse"
          : `... (${lines.length - 10} more lines) - click to expand`;
      },
      onMouseOver: function() {
        this.fg = COLORS.primary;
      },
      onMouseOut: function() {
        this.fg = COLORS.textMuted;
      },
    });
    blockBox.add(moreText);
  }
};
