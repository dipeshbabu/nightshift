import { homedir } from "os"
import { join } from "path"

const home = homedir()
const nightshiftDir = join(home, ".nightshift")

export namespace Global {
  export const Path = {
    home,
    data: nightshiftDir,
    config: join(nightshiftDir, "config"),
    state: join(nightshiftDir, "state"),
    log: join(nightshiftDir, "log"),
    cache: join(nightshiftDir, "cache"),
    bin: join(nightshiftDir, "bin"),
  }
}
