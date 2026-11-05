import { createEdge } from "./index.ts";

import type { EdgeEnv } from "./index.ts";

const handler = createEdge();

// Workers load the module's default export; there is no named alternative.
// eslint-disable-next-line import-x/no-default-export
export default {
  fetch: (request: Request, env: EdgeEnv): Promise<Response> => handler(request, env),
};
