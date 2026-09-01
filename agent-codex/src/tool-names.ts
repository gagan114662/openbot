/**
 * Codex reserves the `mcp__` namespace for MCP servers it owns. OpenBot uses that same prefix for
 * governed deployment tools, so they need a reversible per-run alias at the adapter boundary.
 */
export function codexToolAlias(name: string): string {
  const readable = name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 48);
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(name)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return `openbot_${readable}_${hash.toString(16).padStart(8, "0")}`;
}

export function codexToolNames(names: readonly string[]) {
  const originalByAlias = new Map<string, string>();
  const aliasByOriginal = new Map<string, string>();
  for (const name of names) {
    const alias = codexToolAlias(name);
    const collision = originalByAlias.get(alias);
    if (collision && collision !== name) {
      throw new Error("Two deployment tools resolved to the same Codex alias.");
    }
    originalByAlias.set(alias, name);
    aliasByOriginal.set(name, alias);
  }
  return { originalByAlias, aliasByOriginal };
}
