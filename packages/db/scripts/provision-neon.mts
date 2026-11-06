// Creates the five service roles on a Neon (or any managed Postgres) database and writes their connection strings to a
// private file outside the repository. Replaces running infra/neon/provision-roles.sql by hand with psql.
//
//   OWNER_URL="postgresql://<owner>:<password>@<host>/wise_biz?sslmode=require" \
//   [READ_HOST="<read replica host>"] \
//   pnpm -F @wise-biz/db provision-neon staging
//
// Refuses to run twice (the roles already exist): rotate passwords with docs/runbooks/rotate-secrets.md instead.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import pg from "pg";

import { SERVICE_ROLES, connectionUrls, provisionStatements } from "../src/provision.ts";

import type { Passwords } from "../src/provision.ts";

const environment = process.argv[2];
if (environment !== "staging" && environment !== "production") {
  console.error("usage: provision-neon <staging|production>   (OWNER_URL in the environment)");
  process.exit(2);
}
const ownerUrl = process.env["OWNER_URL"];
if (ownerUrl === undefined || ownerUrl === "") {
  console.error(
    "OWNER_URL is required: the owner connection string from the Neon console (direct host).",
  );
  process.exit(2);
}
const dbname = new URL(ownerUrl).pathname.replace(/^\//, "") || "wise_biz";

const passwords = Object.fromEntries(
  SERVICE_ROLES.map((r) => [r.role, randomBytes(36).toString("base64url")]),
) as Passwords;

const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
try {
  const existing = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1)",
    [SERVICE_ROLES.map((r) => r.role)],
  );
  if (existing.rows.length > 0) {
    console.error(
      `Already provisioned (${existing.rows.map((r) => r.rolname).join(", ")} exist). Nothing changed.`,
    );
    process.exit(1);
  }
  const statements = provisionStatements(dbname, passwords, {
    literal: (s) => client.escapeLiteral(s),
    identifier: (s) => client.escapeIdentifier(s),
  });
  for (const sql of statements) {
    if (sql.startsWith("ALTER DATABASE")) {
      // Changing the owner needs the right to SET ROLE to the new owner; the role's creator may not have it by default.
      await client.query("GRANT wb_migrator TO CURRENT_USER WITH SET TRUE").catch(() => undefined);
    }
    await client.query(sql);
  }
} finally {
  await client.end();
}

const urls = connectionUrls(ownerUrl, dbname, passwords, process.env["READ_HOST"]);
const file = join(homedir(), `wise-biz-${environment}-database-urls.txt`);
writeFileSync(
  file,
  Object.entries(urls)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
console.log(`Roles created on ${dbname}.`);
console.log(`Connection strings written to ${file}`);
console.log(
  "Put each into Secret Manager as wb-" +
    environment +
    "-<NAME> (first-release.md part 4), then delete the file.",
);
