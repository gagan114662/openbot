import { describe, expect, test } from "bun:test";
import {
  createFirstPaintDelays,
  splitSkillChip,
} from "../src/components/channels/chat-transcript";

describe("chat transcript projections", () => {
  test("only a granted leading slash command becomes a skill chip", () => {
    expect(splitSkillChip("/research competitors", "research,write")).toEqual({
      chip: "research",
      rest: "competitors",
    });
    expect(splitSkillChip("/etc/hosts is broken", "research,write")).toBeNull();
  });

  test("historical messages stagger once and live messages arrive immediately", () => {
    const delays = createFirstPaintDelays();
    expect(delays.delayFor("history-1", 0, 2)).toBe(0);
    expect(delays.delayFor("history-2", 1, 2)).toBe(0.04);
    delays.settle();
    expect(delays.delayFor("live", 2, 3)).toBe(0);
    expect(delays.delayFor("history-2", 1, 2)).toBe(0.04);
  });
});
