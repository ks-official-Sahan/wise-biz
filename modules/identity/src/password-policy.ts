// Ported from @sahan-sac/auth-kit 0.12.1 `password-policy` (Apache-2.0,
// github.com/ks-official-Sahan/Sahan, packages/auth-kit). Ported rather than imported: the package declares
// bcryptjs, ua-parser-js and @upstash/* as hard dependencies that a Hono/node-redis API does not want (ADR 0010).
// Changes: TypeScript strictness only; same rules and word list (author-specific entries dropped).

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordContext {
  email?: string | null;
  name?: string | null;
}

export interface PasswordCheck {
  ok: boolean;
  /** Plain sentences, safe to show to the user. */
  problems: string[];
}

const COMMON: ReadonlySet<string> = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "passw0rd",
  "p@ssw0rd",
  "p@ssword",
  "admin",
  "admin123",
  "administrator",
  "welcome",
  "welcome1",
  "welcome123",
  "letmein",
  "qwerty",
  "qwerty123",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "1q2w3e4r",
  "1qaz2wsx",
  "iloveyou",
  "monkey",
  "dragon",
  "football",
  "baseball",
  "superman",
  "batman",
  "sunshine",
  "princess",
  "master",
  "shadow",
  "trustno1",
  "abc123",
  "abcd1234",
  "changeme",
  "changeit",
  "default",
  "secret",
  "test1234",
  "testtest",
  "portfolio",
  "internet",
  "computer",
  "whatever",
  "freedom",
  "starwars",
  "login",
  "hello123",
  "123456789",
  "1234567890",
  "12345678",
  "123123123",
  "111111111111",
  "000000000000",
]);

const CLASSES = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];

function letters(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

export function checkPassword(password: string, context: PasswordContext = {}): PasswordCheck {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Use at most ${String(PASSWORD_MAX_LENGTH)} characters.`);
  }
  if (CLASSES.filter((re) => re.test(password)).length < 3) {
    problems.push("Mix at least three of: lower case, upper case, digits and symbols.");
  }
  const lowered = password.toLowerCase();
  const email = context.email?.trim().toLowerCase();
  if (email) {
    const local = email.split("@")[0] ?? "";
    if (lowered === email || (local.length >= 4 && lowered === local)) {
      problems.push("Do not use your email address as your password.");
    }
  }
  const alpha = letters(password);
  if (COMMON.has(lowered) || (alpha.length >= 5 && COMMON.has(alpha))) {
    problems.push("That password is too common. Pick something less guessable.");
  }
  return { ok: problems.length === 0, problems };
}
