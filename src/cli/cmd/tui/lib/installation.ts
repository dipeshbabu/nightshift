import z from "zod"
import { BusEvent } from "./bus"

export const Installation = {
  VERSION: "0.1.0",
  isLocal(): boolean {
    return false
  },
  Event: {
    UpdateAvailable: BusEvent.define(
      "installation.update.available",
      z.object({
        version: z.string(),
      })
    ),
  },
}
