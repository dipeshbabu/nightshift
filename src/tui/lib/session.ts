import z from "zod"
import { BusEvent } from "./bus"

export namespace Session {
  export const Event = {
    Created: BusEvent.define(
      "session.created",
      z.object({
        info: z.object({
          id: z.string(),
        }),
      })
    ),
    Updated: BusEvent.define(
      "session.updated",
      z.object({
        info: z.object({
          id: z.string(),
        }),
      })
    ),
    Deleted: BusEvent.define(
      "session.deleted",
      z.object({
        info: z.object({
          id: z.string(),
        }),
      })
    ),
    Diff: BusEvent.define(
      "session.diff",
      z.object({
        sessionID: z.string(),
      })
    ),
    Error: BusEvent.define(
      "session.error",
      z.object({
        error: z.any().optional(),
      })
    ),
  }

  export function isDefaultTitle(title: string): boolean {
    // Check if title matches default patterns like "New session - 2024-01-..." or "Child session - ..."
    return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}/.test(title)
  }
}
