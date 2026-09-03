import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { artifactChecksum } from "./workflow-runtime";
import { persistReviewMaterial } from "./codex-workflow-executor";

test("review material is retrievable, permission-restricted, and byte-bound to its checksum", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-review-material-"));
  try {
    const content = JSON.stringify({
      result: "real output",
      diff: "real diff",
    });
    const material = await persistReviewMaterial(
      directory,
      "worker-session",
      content,
    );
    expect(await readFile(material.path, "utf8")).toBe(content);
    expect(material.checksum).toBe(artifactChecksum(content));
    expect((await stat(material.path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
