import type { ParsedKey } from "@opentui/core"

export namespace Keybind {
  export interface Info {
    name: string
    ctrl?: boolean
    meta?: boolean
    shift?: boolean
    super?: boolean
    leader?: boolean
  }

  export function parse(input: string | string[] | undefined): Info[] {
    if (!input) return []
    const inputs = Array.isArray(input) ? input : [input]
    return inputs.map(parseSingle)
  }

  function parseSingle(input: string): Info {
    const parts = input.toLowerCase().split("+")
    const result: Info = { name: "" }

    for (const part of parts) {
      switch (part) {
        case "ctrl":
        case "control":
          result.ctrl = true
          break
        case "meta":
        case "alt":
        case "option":
          result.meta = true
          break
        case "shift":
          result.shift = true
          break
        case "super":
        case "cmd":
        case "command":
          result.super = true
          break
        case "<leader>":
        case "leader":
          result.leader = true
          break
        default:
          result.name = part
      }
    }

    return result
  }

  export function fromParsedKey(evt: ParsedKey, leader: boolean): Info {
    return {
      name: evt.name ?? "",
      ctrl: evt.ctrl,
      meta: evt.meta,
      shift: evt.shift,
      super: evt.super,
      leader,
    }
  }

  export function match(keybind: Info, evt: Info): boolean {
    return (
      keybind.name.toLowerCase() === evt.name.toLowerCase() &&
      !!keybind.ctrl === !!evt.ctrl &&
      !!keybind.meta === !!evt.meta &&
      !!keybind.shift === !!evt.shift &&
      !!keybind.super === !!evt.super &&
      !!keybind.leader === !!evt.leader
    )
  }

  export function toString(info: Info): string {
    const parts: string[] = []
    if (info.leader) parts.push("<leader>")
    if (info.ctrl) parts.push("ctrl")
    if (info.meta) parts.push("alt")
    if (info.shift) parts.push("shift")
    if (info.super) parts.push("cmd")
    if (info.name) parts.push(info.name)
    return parts.join("+")
  }

  export function format(info: Info): string {
    return toString(info)
  }
}
