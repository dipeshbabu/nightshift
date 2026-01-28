import { RGBA } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useTheme } from "@tui/context/theme"

const BIRD_PIXELS = [
  "....GGGGGG....",
  "...GHHHHHHG...",
  "..GHHLLLLHHG..",
  ".GHLKLLLKLHG..",
  ".GHHLLLOLLHHG.",
  ".GHHLLWOWLHHG.",
  ".GHHLLLLLLHHG.",
  "..GGYYYYYYGG..",
  "...GGYYYYGG...",
  "...DD....DD...",
]

const BIRD_COLORS: Record<string, RGBA> = {
  G: RGBA.fromHex("#7aa51a"),
  H: RGBA.fromHex("#92c137"),
  D: RGBA.fromHex("#5a8a0a"),
  L: RGBA.fromHex("#f7f37b"),
  Y: RGBA.fromHex("#d6d100"),
  K: RGBA.fromHex("#111111"),
  O: RGBA.fromHex("#f6a11a"),
  W: RGBA.fromHex("#f7f4ea"),
}

type LogoProps = {
  width?: number
  mode?: "scan" | "left" | "right" | "hidden"
  snark?: string
}

export function Logo(props: LogoProps) {
  const [frame, setFrame] = createSignal(0)
  const { theme } = useTheme()
  const birdWidth = BIRD_PIXELS[0]?.length ?? 0
  const holdStart = 30
  const holdEnd = 9

  const mode = createMemo(() => props.mode ?? "scan")
  const bubbleEnabled = createMemo(() => mode() === "left" || mode() === "right")
  const maxBubbleWidth = createMemo(() => {
    const width = props.width ?? birdWidth
    return Math.max(0, width - birdWidth - 2)
  })
  const bubbleWidth = createMemo(() => {
    if (!bubbleEnabled()) return 0
    return Math.max(0, Math.min(22, maxBubbleWidth()))
  })
  const showBubble = createMemo(() => bubbleWidth() >= 8)
  const bubbleGap = createMemo(() => (showBubble() ? 2 : 0))
  const contentWidth = createMemo(() => {
    return birdWidth + (showBubble() ? bubbleWidth() + bubbleGap() : 0)
  })

  const travelWidth = createMemo(() => {
    const width = props.width ?? birdWidth
    return Math.max(1, width - contentWidth() + 1)
  })

  const totalFrames = createMemo(() => {
    const width = travelWidth()
    return width + holdEnd + (width - 1) + holdStart
  })

  const offset = createMemo(() => {
    const width = travelWidth()
    if (width <= 1) return 0
    if (mode() === "left") return 0
    if (mode() === "right") return width - 1
    const total = totalFrames()
    const current = total > 0 ? frame() % total : 0
    if (current < width) return current
    if (current < width + holdEnd) return width - 1
    if (current < width + holdEnd + (width - 1)) {
      const backwardIndex = current - width - holdEnd
      return width - 2 - backwardIndex
    }
    return 0
  })

  createEffect(() => {
    const total = totalFrames()
    if (mode() !== "scan" || total <= 1) return
    const interval = setInterval(() => {
      setFrame((current) => (current + 1) % total)
    }, 90)

    onCleanup(() => clearInterval(interval))
  })


  if (mode() === "hidden") return null

  const Bird = (
    <box flexDirection="column">
      <For each={BIRD_PIXELS}>
        {(row) => (
          <box flexDirection="row" gap={0}>
            <For each={row.split("")}>
              {(cell) => {
                if (cell === ".") {
                  return <text selectable={false}>{" "}</text>
                }
                const fg = BIRD_COLORS[cell]
                return (
                  <text fg={fg} selectable={false}>
                    █
                  </text>
                )
              }}
            </For>
          </box>
        )}
      </For>
    </box>
  )

  const Bubble = (
    <box
      width={bubbleWidth()}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundPanel}
      border={["top", "bottom", "left", "right"]}
      borderColor={theme.border}
    >
      <text fg={theme.text} wrapMode="word" width="100%" selectable={false}>
        {props.snark ?? "..."}
      </text>
    </box>
  )

  return (
    <box flexDirection="row" alignItems="center" gap={bubbleGap()} marginLeft={offset()}>
      <Show when={mode() === "right" && showBubble()}>{Bubble}</Show>
      {Bird}
      <Show when={mode() === "left" && showBubble()}>{Bubble}</Show>
    </box>
  )
}
