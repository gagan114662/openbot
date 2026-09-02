import { describe, expect, test } from "bun:test";
import { serverBinding } from "../src/server-binding";

describe("server binding", () => {
  test("reports the configured listening host", () => {
    expect(serverBinding("0.0.0.0", 3001)).toEqual({
      hostname: "0.0.0.0",
      url: "http://0.0.0.0:3001",
    });
  });

  test("keeps localhost as the default", () => {
    expect(serverBinding(undefined, 3001)).toEqual({
      hostname: "localhost",
      url: "http://localhost:3001",
    });
  });
});
