// Sets up a Neon (or any managed Postgres) database for wise-biz: the five service roles, the extensions and the
// privileges, and writes the roles' connection strings to a private file outside the repository. Replaces running
// infra/neon/provision-roles.sql by hand with psql.
//
//   OWNER_URL="postgresql://<owner>:<password>@<direct host>/wise_biz?sslmode=verify-full" \
//   [READ_HOST="<read replica host>"] \
//   pnpm -F @wise-biz/db provision-neon staging
//
// Safe to run again: if the roles exist it skips creating them (their passwords stay as they are, nothing is written)
// and repeats the database setup, which is what to do when a first run was pointed at the wrong database.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import pg from "pg";

import {
  SERVICE_ROLES,
  WRONG_DATABASES,
  connectionUrls,
  databaseStatements,
  roleStatements,
} from "../src/provision.ts";

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
const dbname = new URL(ownerUrl).pathname.replace(/^\//, "");
if (dbname === "" || (WRONG_DATABASES as readonly string[]).includes(dbname)) {
  console.error(
    `OWNER_URL points at the database "${dbname}". The application lives in "wise_biz": change the end of the string to /wise_biz?sslmode=verify-full`,
  );
  process.exit(2);
}

const passwords = Object.fromEntries(
  SERVICE_ROLES.map((r) => [r.role, randomBytes(36).toString("base64url")]),
) as Passwords;

const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
let created = false;
try {
  const existing = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1)",
    [SERVICE_ROLES.map((r) => r.role)],
  );
  if (existing.rows.length === 0) {
    for (const sql of roleStatements(passwords, { literal: (s) => client.escapeLiteral(s) })) {
      await client.query(sql);
    }
    created = true;
  } else if (existing.rows.length !== SERVICE_ROLES.length) {
    console.error(
      `Only some roles exist (${existing.rows.map((r) => r.rolname).join(", ")}). Remove them or ask for help; nothing changed.`,
    );
    process.exit(1);
  }
  // Changing owners and default privileges for another role needs membership in it with the right to SET ROLE.
  await client.query("GRANT wb_migrator TO CURRENT_USER WITH SET TRUE").catch(() => undefined);
  for (const sql of databaseStatements(dbname, { identifier: (s) => client.escapeIdentifier(s) })) {
    await client.query(sql);
  }
} finally {
  await client.end();
}

if (!created) {
  console.log(
    `The roles already existed (their passwords are unchanged); database ${dbname} set up again.`,
  );
  console.log(
    "If your saved connection strings end in /neondb, change that part to /" + dbname + ".",
  );
  process.exit(0);
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
console.log(`Roles created and database ${dbname} set up.`);
console.log(`Connection strings written to ${file}`);
console.log(
  "Put each into Secret Manager as wb-" +
    environment +
    "-<NAME> (first-release.md part 4), then delete the file.",
);
