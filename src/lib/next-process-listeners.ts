import type { KnownRejection } from './process-handlers.js';

/**
 * Next.js registers Turbopack's loader-worker scheduler with its native binding for every project
 * it creates (`build/swc/loaderWorkerPool.js`), and the binding takes one per process. When
 * `pp-dev next` creates the Next.js app again on a config restart, that second registration is
 * rejected and nobody handles the rejection. The first scheduler stays in place and keeps serving
 * the new app, so it is harmless.
 */
export const NEXT_WORKER_SCHEDULER_REJECTION: KnownRejection = {
  matches: (reason) => reason instanceof Error && reason.message === 'Worker creator already registered',
  message: "Next.js kept its Turbopack worker pool from before the restart ('Worker creator already registered')",
};

type ListenerProcess = Pick<NodeJS.Process, 'listeners' | 'off'>;
type Listener = (...args: unknown[]) => void;

export interface NextAppListenerTracker {
  /** Call right before creating a Next.js app. */
  beforeCreate: () => void;
  /**
   * Call once that app is prepared. Removes the listeners of the previous app that this one
   * registered again, and returns how many.
   */
  afterCreate: () => number;
}

/**
 * Keeps the process listeners Next.js adds per app from piling up over `pp-dev next` restarts.
 *
 * Creating a Next.js dev app adds `uncaughtException` listeners, and its `close()` leaves them
 * attached. Some of them are added once per process (by a module or behind a guard); removing
 * those would lose them for good, since Next.js doesn't add them again. So only the listeners the
 * next app registers again, the same function code, replace the previous app's.
 */
export function createNextAppListenerTracker(
  events: readonly string[] = ['uncaughtException'],
  processRef: ListenerProcess = process,
): NextAppListenerTracker {
  const listenersOf = (event: string) => processRef.listeners(event as never) as unknown as Listener[];

  let before: Map<string, Set<Listener>> | null = null;
  let previousApp: Map<string, Listener[]> | null = null;

  return {
    beforeCreate() {
      before = new Map(events.map((event) => [event, new Set(listenersOf(event))]));
    },
    afterCreate() {
      if (!before) {
        return 0;
      }

      const snapshot = before;
      const addedByApp = new Map(
        events.map((event) => [event, listenersOf(event).filter((listener) => !snapshot.get(event)!.has(listener))]),
      );
      let removed = 0;

      if (previousApp) {
        for (const [event, oldListeners] of previousApp) {
          const newCode = new Set(addedByApp.get(event)!.map((listener) => listener.toString()));

          for (const listener of oldListeners) {
            if (newCode.has(listener.toString())) {
              processRef.off(event as never, listener as never);
              removed += 1;
            }
          }
        }
      }

      previousApp = addedByApp;
      before = null;

      return removed;
    },
  };
}
