import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const TEST_DIRECTORY = import.meta.dir;
const DECEPTIVE_TITLE = /\b(real|executed)\b|runtime bundle/i;
const TEST_TITLE = /\b(?:test|it|describe)\(\s*["'`]([^"'`]+)["'`]/g;

test("test names describe the observable mechanism without unsupported evidence adjectives", async () => {
  const files = (await readdir(TEST_DIRECTORY)).filter(
    (file) =>
      file.endsWith(".test.ts") || file.endsWith(".integration.test.ts"),
  );
  const violations: string[] = [];
  for (const file of files) {
    const source = await Bun.file(join(TEST_DIRECTORY, file)).text();
    for (const match of source.matchAll(TEST_TITLE)) {
      if (DECEPTIVE_TITLE.test(match[1] ?? ""))
        violations.push(`${file}: ${match[1]}`);
    }
  }
  expect(violations).toEqual([]);
});
