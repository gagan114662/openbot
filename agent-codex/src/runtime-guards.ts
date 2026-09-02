import type { AdapterOperations, RunPermit } from "./operations";

export function positiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type Waiter<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RequestWaiters<T> {
  private readonly pending = new Map<number, Waiter<T>>();

  constructor(private readonly timeoutMs: number) {}

  request(id: number, send: () => Promise<void>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Codex app-server request ${id} exceeded its ${this.timeoutMs}ms timeout.`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void send().catch((error) =>
        this.reject(id, asError(error, "Codex request write failed")),
      );
    });
  }

  resolve(id: number, value: T): boolean {
    const waiter = this.pending.get(id);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.pending.delete(id);
    waiter.resolve(value);
    return true;
  }

  reject(id: number, error: Error): boolean {
    const waiter = this.pending.get(id);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.pending.delete(id);
    waiter.reject(error);
    return true;
  }

  rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.reject(id, error);
  }

  get size(): number {
    return this.pending.size;
  }
}

export class RunPermitLease {
  private finished = false;

  constructor(
    private readonly operations: Pick<AdapterOperations, "finish">,
    private readonly permit: RunPermit,
  ) {}

  finish(succeeded: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.operations.finish(this.permit, succeeded);
  }
}

export function spawnWithPermit<T>(lease: RunPermitLease, start: () => T): T {
  try {
    return start();
  } catch (error) {
    lease.finish(false);
    throw error;
  }
}

export function parseAppServerLine(line: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Codex app-server emitted malformed JSON: ${asError(error, "invalid JSON").message}`,
    );
  }
}

export function childExitError(code: number): Error {
  return new Error(`Codex app-server exited unexpectedly (code ${code}).`);
}

export function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
