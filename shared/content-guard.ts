export type ContentFinding = {
  category: "secret" | "payment_card" | "ssn" | "prompt_injection";
  path: string;
};

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}/i,
];
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const INJECTION =
  /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions|reveal\s+(?:the\s+)?system\s+prompt|act\s+as\s+(?:DAN|developer\s+mode)/i;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function cardIn(text: string): boolean {
  return (text.match(/(?:\d[ -]?){13,19}/g) ?? []).some((candidate) => {
    const digits = candidate.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
  });
}

/** Inspect values without ever returning the matching value itself. */
export function inspectToolArguments(value: unknown): ContentFinding[] {
  const findings: ContentFinding[] = [];
  const visit = (current: unknown, path: string) => {
    if (typeof current === "string") {
      if (SECRET_PATTERNS.some((pattern) => pattern.test(current))) {
        findings.push({ category: "secret", path });
      }
      if (SSN.test(current)) findings.push({ category: "ssn", path });
      if (cardIn(current)) findings.push({ category: "payment_card", path });
      if (INJECTION.test(current)) {
        findings.push({ category: "prompt_injection", path });
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => {
        visit(item, `${path}[${index}]`);
      });
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) {
        visit(item, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(value, "args");
  return findings;
}

export function contentRefusal(findings: ContentFinding[]): string | null {
  if (findings.length === 0) return null;
  const categories = [...new Set(findings.map((finding) => finding.category))];
  return `Refused. Content protection detected ${categories.join(", ")} in tool arguments. No matching value was logged or sent.`;
}
