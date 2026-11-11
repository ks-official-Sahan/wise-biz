/**
 * Text scrubber for diagnostic messages. Pure. Every pattern is applied to the whole (bounded) text, and truncation to
 * MAX_MESSAGE_CHARS happens only after scrubbing, so a secret cannot survive by being cut in half.
 *
 * Order matters: bearer and key=value first, then emails (they contain tokens-like runs), then long mixed tokens, and
 * digit runs last (a token can contain digits that a digit rule would otherwise break up).
 *
 * Known limit: a long run of letters only (no digit) is not a token by this rule, and a 9-12 digit run is treated as a
 * phone number even when it is an id. Both over-redact or under-redact in ways the support team can read.
 */

export const MAX_RAW_MESSAGE_CHARS = 2_000;
export const MAX_MESSAGE_CHARS = 200;

// Control characters are the point of this pattern: log lines must not carry raw line breaks or NULs.
// eslint-disable-next-line no-control-regex -- matching control characters is the intent
const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE_SECRET_RE =
  /\b(token|secret|password|passwd|api[_-]?key|authorization)(\s*[=:]\s*)\S+/gi;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const MIXED_TOKEN_RE = /[A-Za-z0-9+/_=-]{24,}/g;
const DIGIT_RUN_RE = /\+?\d(?:[ ().-]*\d)*/g;

const hasDigit = (s: string): boolean => /\d/.test(s);
const hasLetter = (s: string): boolean => /[A-Za-z]/.test(s);

/** Long runs that mix letters and digits are tokens, hashes or keys. Run-only digits are handled as numbers. */
const isMixedToken = (run: string): boolean => hasDigit(run) && hasLetter(run);

function scrubDigitRun(run: string): string {
  const digits = run.replace(/\D/g, "").length;
  if (digits >= 13) return "[card]";
  if (digits >= 9) return "[phone]";
  return run;
}

/** Scrubs one diagnostic text. Output contains no email, bearer token, mixed token or 9+ digit run. */
export function scrubText(text: string): string {
  return text
    .replace(CONTROL_RE, " ")
    .replace(BEARER_RE, "Bearer [token]")
    .replace(KEY_VALUE_SECRET_RE, (_m, key: string, sep: string) => `${key}${sep}[redacted]`)
    .replace(EMAIL_RE, "[email]")
    .replace(MIXED_TOKEN_RE, (run) => (isMixedToken(run) ? "[secret]" : run))
    .replace(DIGIT_RUN_RE, scrubDigitRun);
}

/** Bounded message: raw input is capped before any regex runs; scrub first, then cut to MAX_MESSAGE_CHARS code points. */
export function scrubMessage(raw: string): string {
  const scrubbed = scrubText(raw.slice(0, MAX_RAW_MESSAGE_CHARS));
  return Array.from(scrubbed).slice(0, MAX_MESSAGE_CHARS).join("");
}
