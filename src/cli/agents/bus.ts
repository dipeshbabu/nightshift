import type { RalphEvent, RalphEventType } from "./events";

export interface EventPublisher {
  publish(event: RalphEvent): void;
}

export function taggedPublisher(bus: EventBus, runId: string): EventPublisher {
  return {
    publish: (event) => bus.publish({ ...event, runId }),
  };
}

type Callback<E> = (event: E) => void;
type Unsubscribe = () => void;

export class EventBus {
  private listeners = new Map<RalphEventType, Set<Callback<any>>>();
  private allListeners = new Set<Callback<RalphEvent>>();

  publish(event: RalphEvent): void {
    const typed = this.listeners.get(event.type);
    if (typed) for (const cb of typed) cb(event);
    for (const cb of this.allListeners) cb(event);
  }

  subscribe<T extends RalphEventType>(
    type: T,
    cb: Callback<Extract<RalphEvent, { type: T }>>,
  ): Unsubscribe {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  subscribeAll(cb: Callback<RalphEvent>): Unsubscribe {
    this.allListeners.add(cb);
    return () => this.allListeners.delete(cb);
  }
}

export function createBus(): EventBus {
  return new EventBus();
}
