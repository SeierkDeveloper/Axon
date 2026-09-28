// The tasks the worker is executing right now.
//
// The poll used to await each task before moving on, so one slow inference held the whole loop: no other
// agent picked up work, the heartbeat stopped, and after ten minutes the health check reported a dead
// worker that was merely busy. Tasks now start here and run on their own; the poll only decides what to
// start. This keeps the promises so shutdown can still wait for work in progress to finish.

const running = new Map<string, Promise<void>>();

/** Start a task's execution without waiting for it. A task already running here is not started twice. */
export function launch(taskId: string, run: () => Promise<void>): boolean {
  if (running.has(taskId)) return false;
  const p = Promise.resolve()
    .then(run)
    .catch(() => {
      /* execution reports its own failures; a throw here must not become an unhandled rejection */
    })
    .finally(() => {
      running.delete(taskId);
    });
  running.set(taskId, p);
  return true;
}

/** How many tasks are executing. */
export const inFlightCount = (): number => running.size;

/** Whether a task is executing in this process. */
export const isInFlight = (taskId: string): boolean => running.has(taskId);

/** Resolves once every task running now has finished, or after `timeoutMs`, whichever comes first. */
export async function drain(timeoutMs: number): Promise<"done" | "timeout"> {
  const all = Promise.allSettled([...running.values()]).then(() => "done" as const);
  if (timeoutMs <= 0) return all;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([all, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
