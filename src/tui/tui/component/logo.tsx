import { RGBA } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useTheme } from "@tui/context/theme"

const BIRD_PIXELS = [
  "..HHHHHHHHH..",
  ".GLLLHHHLLLG.",
  "HHLLKLLLKLLHH",
  "HHLLKLOOKLLHH",
  "HHLLLOWOLLLHH",
  "HHLLLLOLLLLHH",
  "HHHHHHHHHHHHH",
  ".HHHHHHHHHHH.",
  "..GGG...GGG..",
]

const BIRD_COLORS: Record<string, RGBA> = {
  G: RGBA.fromHex("#4E8019"),
  H: RGBA.fromHex("#6C9B21"),
  L: RGBA.fromHex("#F7F174"),
  K: RGBA.fromHex("#222222"),
  O: RGBA.fromHex("#FA9E28"),
  W: RGBA.fromHex("#FACB40"),
}

type LogoProps = {
  width?: number
  mode?: "scan" | "left" | "right"
}

export function Logo(props: LogoProps) {
  const [frame, setFrame] = createSignal(0)
  const { theme } = useTheme()
  const birdWidth = BIRD_PIXELS[0]?.length ?? 0
  const holdStart = 30
  const holdEnd = 9

  const mode = createMemo(() => props.mode ?? "scan")
  const titleEnabled = createMemo(() => mode() === "left" || mode() === "right")
  const titleWidth = "Nightshift".length
  const titleGap = createMemo(() => (titleEnabled() ? 2 : 0))
  const contentWidth = createMemo(() => {
    return birdWidth + (titleEnabled() ? titleWidth + titleGap() : 0)
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

  const Title = (
    <text fg={theme.text} selectable={false}>
      Nightshift
    </text>
  )

  return (
    <box flexDirection="row" alignItems="center" gap={titleGap()} marginLeft={offset()}>
      <Show when={mode() === "right" && titleEnabled()}>{Title}</Show>
      {Bird}
      <Show when={mode() === "left" && titleEnabled()}>{Title}</Show>
    </box>
  )
}
