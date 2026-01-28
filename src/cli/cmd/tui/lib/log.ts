export namespace Log {
  export interface Logger {
    debug(message: string, data?: Record<string, unknown>): void
    info(message: string, data?: Record<string, unknown>): void
    warn(message: string, data?: Record<string, unknown>): void
    error(message: string, data?: Record<string, unknown>): void
  }

  function createLogger(): Logger {
    // No-op logger for client mode - server handles logging
    return {
      debug(_message: string, _data?: Record<string, unknown>) {},
      info(_message: string, _data?: Record<string, unknown>) {},
      warn(_message: string, _data?: Record<string, unknown>) {},
      error(message: string, data?: Record<string, unknown>) {
        // Only log errors to console in debug mode
        if (process.env.DEBUG) {
          console.error(message, data)
        }
      },
    }
  }

  export const Default = createLogger()

  export function create(_name?: string): Logger {
    return createLogger()
  }
}
