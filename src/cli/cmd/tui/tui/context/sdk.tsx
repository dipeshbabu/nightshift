import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup, onMount } from "solid-js"
import { appendFileSync } from "fs"

const log = (msg: string) => {
  try { appendFileSync("/tmp/nightshift-sdk.log", `${new Date().toISOString()} ${msg}\n`) } catch {}
}

export type EventSource = {
  on: (handler: (event: Event) => void) => () => void
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { url: string; directory?: string; fetch?: typeof fetch; events?: EventSource }) => {
    log(`[sdk] init url=${props.url} directory=${props.directory}`)
    const abort = new AbortController()

    // Wrap fetch to log all requests
    const wrappedFetch: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init)
      log(`[sdk] ${req.method} ${req.url}`)
      log(`[sdk] headers: ${JSON.stringify(Object.fromEntries(req.headers.entries()))}`)
      if (init?.body) {
        log(`[sdk] body: ${typeof init.body === 'string' ? init.body : JSON.stringify(init.body)}`)
      }
      const res = await (props.fetch ?? fetch)(input, init)
      log(`[sdk] response: ${res.status}`)
      if (!res.ok) {
        const clone = res.clone()
        try {
          const text = await clone.text()
          log(`[sdk] error body: ${text}`)
        } catch {}
      }
      return res
    }

    const sdk = createOpencodeClient({
      baseUrl: props.url,
      signal: abort.signal,
      directory: props.directory,
      fetch: wrappedFetch,
    })

    const emitter = createGlobalEmitter<{
      [key in Event["type"]]: Extract<Event, { type: key }>
    }>()

    let queue: Event[] = []
    let timer: Timer | undefined
    let last = 0

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit(event.type, event)
        }
      })
    }

    const handleEvent = (event: Event) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    onMount(async () => {
      // If an event source is provided, use it instead of SSE
      if (props.events) {
        const unsub = props.events.on(handleEvent)
        onCleanup(unsub)
        return
      }

      // Fall back to SSE
      log(`[sdk] SSE subscribing`)
      while (true) {
        if (abort.signal.aborted) break
        try {
          const events = await sdk.event.subscribe(
            {},
            {
              signal: abort.signal,
            },
          )
          log(`[sdk] SSE connected`)

          for await (const event of events.stream) {
            log(`[sdk] event: ${event.type}`)
            handleEvent(event)
          }
          log(`[sdk] SSE stream ended`)
        } catch (err) {
          log(`[sdk] SSE error: ${err}`)
        }

        // Flush any remaining events
        if (timer) clearTimeout(timer)
        if (queue.length > 0) {
          flush()
        }

        if (!abort.signal.aborted) {
          console.error("[sdk] Reconnecting in 250ms...")
          await new Promise((r) => setTimeout(r, 250))
        }
      }
    })

    onCleanup(() => {
      abort.abort()
      if (timer) clearTimeout(timer)
    })

    return { client: sdk, event: emitter, url: props.url }
  },
})
