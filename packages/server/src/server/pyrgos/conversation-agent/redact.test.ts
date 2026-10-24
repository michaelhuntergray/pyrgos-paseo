import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

// The pre-MIC-761 patterns, kept here as the reference: the linear rewrite must redact exactly as they did.
const LEGACY: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[private-key]",
  ],
  [
    /(--?[A-Za-z0-9_-]*(?:pass|pwd|secret|token|key|auth|credential)[A-Za-z0-9_-]*[=\s]+)(\S+)/gi,
    "$1[redacted]",
  ],
  [/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/]+@/g, "[url-credentials]@"],
  [
    /\b(?:lin_api_|lin_oauth_|sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[bp]-|gsk_)[A-Za-z0-9_-]{8,}/g,
    "[redacted]",
  ],
  [/\bAKIA[0-9A-Z]{12,}\b/g, "[redacted]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [
    /([A-Za-z0-9_.-]*(?:pass|pwd|secret|token|key|auth|credential)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1[redacted]",
  ],
];

function legacyRedact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of LEGACY) out = out.replace(pattern, replacement);
  return out;
}

const timed = (text: string): number => {
  const start = performance.now();
  redact(text);
  return performance.now() - start;
};

describe("redact performance (MIC-761)", () => {
  const n = 50_000;
  it.each([
    ["a word run", "x".repeat(n)],
    ["a dashed run", "-x".repeat(n / 2)],
    ["repeated keywords", "key".repeat(Math.floor(n / 3))],
    ["a dotted run", "a.".repeat(n / 2)],
    ["a run with digits", "1a+".repeat(Math.floor(n / 3))],
  ])("redacts 50k chars of %s in under 200 ms", (_name, text) => {
    expect(timed(text)).toBeLessThan(200);
  });
});

describe("redact matches the legacy patterns", () => {
  const aws = ["AK", "IA", "0123456789ABCDEF"].join(""); // built at runtime so secret scanners skip the fixture
  const cases = [
    "password: hunter2",
    "foo=key=secret",
    "a-key x",
    "run --token abc123xyz and more",
    "---key value",
    "key-x y",
    "1abc://user:pw@host/path",
    "see https://user:pw@example.com and x.y+z://a:b@c",
    "export API_KEY='quoted value' next",
    'my.secret.name = "double quoted"',
    "Authorization: Bearer abcdefghijklmnop12345",
    "lin_api_abcdefghijklmnop and ghp_0123456789abcdef",
    `${aws} done`,
    "x-auth-token: abc, other",
    "nothing to see here",
    "keykey keykey=1",
    "-x-password  hidden",
  ];
  it.each(cases)("%s", (text) => {
    expect(redact(text)).toBe(legacyRedact(text));
  });

  it("agrees on random strings built from tricky pieces", () => {
    const pieces = [
      "key",
      "pass",
      "-",
      "--",
      ".",
      "+",
      "1",
      "a",
      "=",
      ":",
      " ",
      "'",
      '"',
      "://",
      "@",
      "u:p",
      "Z",
      "_",
    ];
    let seed = 761;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 3000; i++) {
      let s = "";
      const len = 1 + Math.floor(rand() * 12);
      for (let j = 0; j < len; j++) s += pieces[Math.floor(rand() * pieces.length)];
      expect(redact(s), JSON.stringify(s)).toBe(legacyRedact(s));
    }
  });
});
