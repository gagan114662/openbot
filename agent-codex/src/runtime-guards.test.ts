import { describe, expect, test } from "bun:test";
import {
  parseAppServerLine,
  childExitError,
  positiveInteger,
  RequestWaiters,
  RunPermitLease,
  spawnWithPermit,
} from "./runtime-guards";

describe("Codex app-server request lifecycle", () => {
  test("child death rejects every in-flight request and clears the waiter map", async () => {
    const waiters = new RequestWaiters<Record<string, unknown>>(1_000);
    const first = waiters.request(1, async () => {});
    const second = waiters.request(2, async () => {});
    waiters.rejectAll(new Error("Codex app-server exited with code 9"));
    await expect(first).rejects.toThrow("exited with code 9");
    await expect(second).rejects.toThrow("exited with code 9");
    expect(waiters.size).toBe(0);
  });

  test("a request times out and removes itself", async () => {
    const waiters = new RequestWaiters<Record<string, unknown>>(5);
    await expect(waiters.request(4, async () => {})).rejects.toThrow(
      "exceeded its 5ms timeout",
    );
    expect(waiters.size).toBe(0);
  });

  test("a failed stdin write rejects and removes its request", async () => {
    const waiters = new RequestWaiters<Record<string, unknown>>(1_000);
    await expect(
      waiters.request(5, async () => {
        throw new Error("broken pipe");
      }),
    ).rejects.toThrow("broken pipe");
    expect(waiters.size).toBe(0);
  });

  test("garbage stdout is a named protocol failure", () => {
    expect(() => parseAppServerLine("not-json")).toThrow(
      "emitted malformed JSON",
    );
    expect(() => parseAppServerLine("[]")).toThrow("emitted malformed JSON");
  });

  test("child stderr is never included in the user-facing exit error", () => {
    const error = childExitError(9);
    expect(error.message).toBe(
      "Codex app-server exited unexpectedly (code 9).",
    );
    expect(error.message).not.toContain("secret-looking-stderr");
  });
});

describe("Codex run permits", () => {
  test("spawn failure releases the permit exactly once", () => {
    const finished: boolean[] = [];
    const lease = new RunPermitLease(
      { finish: (_permit, success) => finished.push(success) },
      { startedAt: 1 } as never,
    );
    expect(() =>
      spawnWithPermit(lease, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow("ENOENT");
    lease.finish(true);
    expect(finished).toEqual([false]);
  });

  test("every later exit path is idempotent", () => {
    const finished: boolean[] = [];
    const lease = new RunPermitLease(
      { finish: (_permit, success) => finished.push(success) },
      { startedAt: 1 } as never,
    );
    lease.finish(false);
    lease.finish(false);
    expect(finished).toEqual([false]);
  });
});

test("invalid and NaN caps fall back instead of disabling limits", () => {
  expect(positiveInteger("NaN", 4)).toBe(4);
  expect(positiveInteger("0", 4)).toBe(4);
  expect(positiveInteger("-2", 4)).toBe(4);
  expect(positiveInteger("7", 4)).toBe(7);
});
