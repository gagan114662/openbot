const assetDirectory = "app/dist/assets";
const maximumChunkBytes = 1_200 * 1024;

const assets = Array.from(
  new Bun.Glob("*.js").scanSync({ cwd: assetDirectory, absolute: true }),
).map((path) => ({ path, bytes: Bun.file(path).size }));

if (assets.length === 0) {
  throw new Error(
    "No production JavaScript assets found; run the app build first.",
  );
}

const largest = assets.sort((a, b) => b.bytes - a.bytes)[0];
if (!largest) throw new Error("No JavaScript chunks were measured.");
if (largest.bytes > maximumChunkBytes) {
  throw new Error(
    `Largest JavaScript chunk is ${(largest.bytes / 1024).toFixed(1)} KiB; budget is ${maximumChunkBytes / 1024} KiB.`,
  );
}

const requiredPrefixes = [
  "ag-ui-",
  "copilotkit-react-",
  "copilotkit-runtime-",
  "tanstack-",
];
const names = assets.map(({ path }) => path.split("/").at(-1) ?? "");
for (const prefix of requiredPrefixes) {
  if (!names.some((name) => name.startsWith(prefix))) {
    throw new Error(`Expected production chunk ${prefix}* was not emitted.`);
  }
}

console.log(
  `Frontend bundle budget passed: chunks=${assets.length} largest_kib=${(largest.bytes / 1024).toFixed(1)} budget_kib=${maximumChunkBytes / 1024}`,
);
