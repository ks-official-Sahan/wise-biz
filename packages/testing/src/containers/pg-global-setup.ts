import { postgresGlobalSetup } from "./global-setup.ts";

// eslint-disable-next-line import-x/no-default-export -- vitest globalSetup requires a default export
export default postgresGlobalSetup();
