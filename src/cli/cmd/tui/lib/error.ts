export function FormatError(error: unknown): string | undefined {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return undefined
}

export function FormatUnknownError(error: unknown): string {
  if (error === null) return "null"
  if (error === undefined) return "undefined"
  if (typeof error === "string") return error
  if (typeof error === "object") {
    if ("message" in error && typeof error.message === "string") {
      return error.message
    }
    return JSON.stringify(error)
  }
  return String(error)
}
