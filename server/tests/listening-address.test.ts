import { describe, expect, test } from "bun:test";
import { listeningHost, listeningUrl } from "../src/listening-address";

describe("server listening address", () => {
  test("reports the configured host used for binding", () => {
    const host = listeningHost({ SERVER_HOST: "0.0.0.0" });

    expect(listeningUrl(host, 3001)).toBe("http://0.0.0.0:3001");
  });

  test("defaults to localhost when no host is configured", () => {
    expect(listeningHost({})).toBe("localhost");
  });

  test("formats an IPv6 listening host as a URL", () => {
    expect(listeningUrl("::", 3001)).toBe("http://[::]:3001");
  });
});
