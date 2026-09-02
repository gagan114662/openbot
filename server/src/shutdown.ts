export type ShutdownSignal = "SIGINT" | "SIGTERM";

export type GracefulShutdownOptions = {
  drain: (signal: ShutdownSignal) => Promise<void>;
  timeoutMs?: number;
  signals?: readonly ShutdownSignal[];
  exit?: (code: number) => void;
};

/**
 * Stop once, drain boundedly, then exit.
 *
 * The timeout is deliberately outside the drain. A wedged dependency must not defeat Kubernetes'
 * termination grace period, while a healthy in-flight delivery gets a real chance to finish and
 * release its lease before the process disappears.
 */
export function installGracefulShutdown(options: GracefulShutdownOptions) {
  const signals = options.signals ?? (["SIGINT", "SIGTERM"] as const);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let stopping = false;

  const handlers = new Map<ShutdownSignal, () => void>();
  for (const signal of signals) {
    const handler = () => {
      if (stopping) return;
      stopping = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      void Promise.race([options.drain(signal), deadline]).finally(() => {
        if (timer) clearTimeout(timer);
        exit(0);
      });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return {
    dispose() {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}
