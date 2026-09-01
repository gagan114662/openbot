export function ratioPercent(numerator = 0, denominator = 0): string {
  return denominator
    ? `${((numerator / denominator) * 100).toFixed(1)}%`
    : "0.0%";
}
