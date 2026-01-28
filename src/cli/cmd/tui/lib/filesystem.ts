import { dirname, join } from "path"

export namespace Filesystem {
  export async function readText(filePath: string): Promise<string | undefined> {
    try {
      const file = Bun.file(filePath)
      if (await file.exists()) {
        return await file.text()
      }
      return undefined
    } catch {
      return undefined
    }
  }

  export async function exists(filePath: string): Promise<boolean> {
    try {
      return await Bun.file(filePath).exists()
    } catch {
      return false
    }
  }

  export async function* up(options: {
    targets: string[]
    start: string
  }): AsyncGenerator<string> {
    let current = options.start

    while (current !== dirname(current)) {
      for (const target of options.targets) {
        const filePath = join(current, target)
        if (await exists(filePath)) {
          yield filePath
        }
      }
      current = dirname(current)
    }
  }

  export function normalizePath(input?: string): string {
    if (!input) return ""
    const cwd = process.cwd()
    const home = process.env.HOME ?? ""
    const absolute = input.startsWith("/") ? input : join(cwd, input)
    const relative = absolute.startsWith(cwd) ? absolute.slice(cwd.length + 1) : absolute
    if (!relative) return "."
    if (!relative.startsWith("..") && !relative.startsWith("/")) return relative
    if (home && absolute.startsWith(home)) return "~" + absolute.slice(home.length)
    return absolute
  }
}
