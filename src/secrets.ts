/**
 * Finds credentials that should never be committed or served: API keys, tokens, private keys and
 * passwords in connection strings. Findings are always redacted; a full secret is never returned.
 */

export type SecretSeverity = "high" | "medium" | "low";

export interface SecretFinding {
  rule: string;
  severity: SecretSeverity;
  line: number;
  column: number;
  /** First 4 and last 2 characters only, plus the length. */
  preview: string;
  advice: string;
}

interface Rule {
  id: string;
  severity: SecretSeverity;
  re: RegExp;
  /** Which capture group holds the secret (default 0). */
  group?: number;
  advice: string;
  /** Extra check on the matched secret to cut false positives. */
  accept?: (secret: string) => boolean;
}

const ROTATE = "Revoke and replace this credential now, then remove it from the code and from git history.";

export const shannonEntropy = (s: string): number => {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
};

const PLACEHOLDER = /(example|sample|placeholder|your[_-]?|changeme|change[_-]me|xxxx|\*{4,}|<[^>]+>|\{\{|\$\{|process\.env|dummy|redacted|todo|fake|test[_-]?key)/i;

const RULES: Rule[] = [
  { id: "Private key block", severity: "high", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g, advice: ROTATE },
  { id: "AWS access key ID", severity: "high", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, advice: ROTATE },
  { id: "AWS secret access key", severity: "high", re: /aws.{0,20}?secret.{0,20}?[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi, group: 1, advice: ROTATE },
  { id: "GitHub token", severity: "high", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, advice: ROTATE },
  { id: "GitHub fine-grained token", severity: "high", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, advice: ROTATE },
  { id: "Slack token", severity: "high", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, advice: ROTATE },
  { id: "Stripe secret key", severity: "high", re: /\b[sr]k_live_[0-9a-zA-Z]{16,}\b/g, advice: ROTATE },
  { id: "Stripe test secret key", severity: "medium", re: /\b[sr]k_test_[0-9a-zA-Z]{16,}\b/g, advice: "Test keys are lower risk, but still should not be committed. Rotate if it was ever shared." },
  { id: "Anthropic API key", severity: "high", re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g, advice: ROTATE },
  { id: "OpenRouter API key", severity: "high", re: /\bsk-or-v1-[a-f0-9]{48,}\b/g, advice: ROTATE },
  { id: "OpenAI API key", severity: "high", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/g, advice: ROTATE, accept: (s) => !s.startsWith("sk-ant-") && !s.startsWith("sk-or-") },
  { id: "Groq API key", severity: "high", re: /\bgsk_[A-Za-z0-9]{40,}\b/g, advice: ROTATE },
  { id: "Google API key", severity: "medium", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, advice: "Google API keys used in browsers are acceptable only if restricted by HTTP referrer and API. Check the key's restrictions, and rotate if it is unrestricted." },
  { id: "Google OAuth client secret", severity: "high", re: /\bGOCSPX-[A-Za-z0-9_-]{24,}\b/g, advice: ROTATE },
  { id: "npm token", severity: "high", re: /\bnpm_[A-Za-z0-9]{36}\b/g, advice: ROTATE },
  { id: "SendGrid API key", severity: "high", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, advice: ROTATE },
  { id: "Twilio API key", severity: "high", re: /\bSK[0-9a-fA-F]{32}\b/g, advice: ROTATE },
  { id: "JSON Web Token", severity: "medium", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, advice: "A JWT may be a live session or access token. If it is real, revoke the session and never ship tokens in front-end code." },
  {
    id: "Credentials in a connection string",
    severity: "high",
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'<>]+:([^\s@/"'<>]{4,})@[^\s/"'<>]+/gi,
    group: 1,
    advice: ROTATE,
    accept: (s) => !PLACEHOLDER.test(s) && !/^(password|pass|pwd|secret|user|root|admin|\*+)$/i.test(s),
  },
  {
    id: "Hard-coded secret assignment",
    severity: "medium",
    re: /\b[\w.-]{0,30}(?:api[_-]?key|secret|token|passwd|password|private[_-]?key|client[_-]?secret|auth[_-]?key)[\w.-]{0,20}["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi,
    group: 1,
    advice: "This looks like a hard-coded credential. Move it to an environment variable or secret manager and rotate it if it is real.",
    accept: (s) => !PLACEHOLDER.test(s) && !/^https?:/i.test(s) && shannonEntropy(s) >= 3.0
  },
];

export const preview = (secret: string): string =>
  secret.length <= 8 ? `${secret.slice(0, 2)}…(${secret.length} chars)` : `${secret.slice(0, 4)}…${secret.slice(-2)} (${secret.length} chars)`;

const MAX_BYTES = 1_000_000;

export function scanSecrets(input: string): SecretFinding[] {
  const text = input.length > MAX_BYTES ? input.slice(0, MAX_BYTES) : input;
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const locate = (idx: number) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: idx - lineStarts[lo] + 1 };
  };

  const found: (SecretFinding & { start: number; end: number })[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const secret = m[rule.group ?? 0];
      if (!secret) continue;
      if (rule.accept && !rule.accept(secret)) continue;
      const start = (m.index ?? 0) + (rule.group ? m[0].indexOf(secret) : 0);
      const end = start + secret.length;
      // A more specific rule already claimed this span (for example an Anthropic key is not also an OpenAI key).
      if (found.some((f) => start < f.end && end > f.start)) continue;
      const { line, column } = locate(start);
      found.push({ rule: rule.id, severity: rule.severity, line, column, preview: preview(secret), advice: rule.advice, start, end });
    }
  }
  return found.sort((a, b) => a.line - b.line || a.column - b.column).map(({ start: _s, end: _e, ...f }) => f);
}

export function formatSecretsReport(findings: SecretFinding[], label = "the text"): string {
  if (!findings.length) {
    return `## Secret scan\nNo credentials found in ${label}.\n\nThis checks for known key formats and obvious hard-coded passwords. It cannot prove a file is clean, so also keep secrets out of git by using environment variables and a \`.gitignore\` for \`.env\` files.`;
  }
  const high = findings.filter((f) => f.severity === "high").length;
  const lines = [
    "## Secret scan",
    `Found **${findings.length}** possible credential${findings.length > 1 ? "s" : ""} in ${label} (${high} high severity). Values are redacted below.`,
    "",
    "| Where | What | Severity | Preview |",
    "|---|---|---|---|",
    ...findings.map((f) => `| line ${f.line}, col ${f.column} | ${f.rule} | ${f.severity} | \`${f.preview}\` |`),
    "",
    "### What to do",
    ...[...new Set(findings.map((f) => f.advice))].map((a) => `- ${a}`),
    "- Do not paste these values into chats, tickets or logs. Share only the redacted previews above.",
  ];
  return lines.join("\n");
}
