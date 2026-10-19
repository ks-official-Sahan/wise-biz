// Module boundary rules (ARCHITECTURE.md "Repository layout", AGENTS.md non-negotiable 9).
// Run: pnpm depcruise. Graph: pnpm deps:graph.

/** Infra clients the pure domain layer must never touch. */
const INFRA_PACKAGES = [
  "drizzle-orm",
  "drizzle-kit",
  "hono",
  "@hono/[^/]+",
  "pg",
  "postgres",
  "@neondatabase/[^/]+",
  "ioredis",
  "redis",
  "@upstash/[^/]+",
  "kafkajs",
  "@confluentinc/[^/]+",
  "better-sqlite3",
  "expo-sqlite",
];

// Matches a bare (unresolved) specifier and a resolved pnpm path
// (…/node_modules/.pnpm/hono@x/node_modules/hono/…). No nested quantifiers: depcruise rejects unsafe regexes.
const infraPath = `(?:^|/node_modules/)(?:${INFRA_PACKAGES.join("|")})(?:/|$)`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-cross-module-internals",
      comment: "A module may import another module only through its contracts.ts.",
      severity: "error",
      from: { path: "^modules/([^/]+)/" },
      to: {
        path: "^modules/[^/]+/",
        pathNot: ["^modules/$1/", "^modules/[^/]+/contracts[.]ts$"],
      },
    },
    {
      name: "packages-stay-framework-free",
      comment:
        "packages/** are reusable building blocks; they must not depend on apps, modules or services.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^(?:apps|modules|services)/" },
    },
    {
      name: "modules-not-to-apps",
      comment:
        "Modules are mounted by apps, never the other way round; services are reached via contracts/events.",
      severity: "error",
      from: { path: "^modules/" },
      to: { path: "^(?:apps|services)/" },
    },
    {
      name: "domain-no-adapters",
      comment: "Domain code is pure: no adapters.",
      severity: "error",
      from: { path: "^modules/[^/]+/domain/" },
      to: { path: "^modules/[^/]+/adapters/" },
    },
    {
      name: "domain-no-infra",
      comment: "Domain code is pure: no DB clients, Hono, Redis, Kafka.",
      severity: "error",
      from: { path: "^modules/[^/]+/domain/" },
      to: { path: infraPath },
    },
    {
      name: "domain-no-node-io",
      comment: "Domain code is pure: no Node built-ins (fs, net, crypto…). Inject ports instead.",
      severity: "error",
      from: { path: "^modules/[^/]+/domain/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment: "Import that cannot be resolved: missing dependency or typo.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // node_modules stays in the graph (not followed) so domain-no-infra can see resolved npm deps.
    exclude: { path: "(^|/)(dist|coverage|\\.turbo)/|/test/fixtures/" },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types"],
    },
    reporterOptions: {
      dot: { collapsePattern: "node_modules/(?:\\.pnpm/[^/]+/node_modules/)?(?:@[^/]+/)?[^/]+" },
    },
  },
};
