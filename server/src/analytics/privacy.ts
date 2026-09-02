export type AnalyticsPrivacyMode =
  | "full"
  | "metadata_only"
  | "customer_enriched";

const REDACTORS: readonly [string, RegExp][] = [
  ["EMAIL", /[^\s@<>]+@[^\s@<>]+\.[^\s@<>.,;:!?]+/giu],
  ["AWS_KEY", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["GOOGLE_KEY", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
  // Hex boundaries matter: UUIDs and trace ids contain long digit/hyphen runs,
  // but are correlation keys rather than phone/card data. Corrupting them
  // breaks multi-turn joins while providing no privacy benefit.
  ["PHONE", /(?<![A-Fa-f0-9])(?:\+?\d[\d ().-]{7,}\d)(?![A-Fa-f0-9])/g],
  ["CARD", /(?<![A-Fa-f0-9])(?:\d[ -]*?){13,19}(?![A-Fa-f0-9])/g],
  ["SSN", /\b\d{3}-?\d{2}-?\d{4}\b/g],
  ["IP", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ["SECRET", /\b(?:sk|pk|rk|xox[abprs]|gh[opusr])[_-]?[A-Za-z0-9_-]{12,}\b/g],
];

export function redactAnalyticsText(value: string): string {
  return REDACTORS.reduce(
    (redacted, [label, pattern]) =>
      redacted.replace(pattern, `[${label}_REDACTED]`),
    value,
  );
}

export function contentForPrivacyMode(
  value: unknown,
  mode: AnalyticsPrivacyMode,
): string | null {
  if (mode !== "full" || typeof value !== "string") return null;
  const bounded = value.trim().slice(0, 100_000);
  return bounded ? redactAnalyticsText(bounded) : null;
}

export function redactAnalyticsProperties(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    depth > 6
  ) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      /secret|password|authorization|credential|api.?key|access.?token|refresh.?token/i.test(
        key,
      )
    ) {
      result[key] = "[REDACTED]";
    } else if (typeof item === "string") {
      result[key] = redactAnalyticsText(item.slice(0, 10_000));
    } else if (Array.isArray(item)) {
      result[key] = item
        .slice(0, 100)
        .map((entry) =>
          typeof entry === "string"
            ? redactAnalyticsText(entry.slice(0, 10_000))
            : entry && typeof entry === "object"
              ? redactAnalyticsProperties(entry, depth + 1)
              : entry,
        );
    } else if (item && typeof item === "object") {
      result[key] = redactAnalyticsProperties(item, depth + 1);
    } else {
      result[key] = item;
    }
  }
  return result;
}
