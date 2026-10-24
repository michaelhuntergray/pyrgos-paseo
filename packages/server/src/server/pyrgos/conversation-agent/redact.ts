// Scrubs secret-shaped text before it reaches a prompt or a log. Ported from the voice agent's
// context.py (itself from the harness mcp/redact.mjs): keep the lists in step.
// Patterns that scan a character run start only where the run starts (the lookbehind) and find their keyword
// with a lookahead, so a long run is scanned once, not once per character (MIC-761).

const PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[private-key]",
  ],
  [
    /(?<![A-Za-z0-9_-])([A-Za-z0-9_]*)(--?(?=[A-Za-z0-9_-]*?(?:pass|pwd|secret|token|key|auth|credential))[A-Za-z0-9_-]*[=\s]+)(\S+)/gi,
    "$1$2[redacted]",
  ],
  [
    /(?<![A-Za-z0-9+.-])([0-9+.-]*)[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/]+@/g,
    "$1[url-credentials]@",
  ],
  [
    /\b(?:lin_api_|lin_oauth_|sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[bp]-|gsk_)[A-Za-z0-9_-]{8,}/g,
    "[redacted]",
  ],
  [/\bAKIA[0-9A-Z]{12,}\b/g, "[redacted]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [
    /(?<![A-Za-z0-9_.-])(?=[A-Za-z0-9_.-]*?(?:pass|pwd|secret|token|key|auth|credential))([A-Za-z0-9_.-]+["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1[redacted]",
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
