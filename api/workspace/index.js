import { createWorkspaceApi } from "../../workspace-api.mjs";
import { createWorkspaceStore } from "../../workspace-store.mjs";
import { createAuthApi } from "../../auth-api.mjs";

// One store per warm function instance, not one per request: a fresh pool on every invocation
// would exhaust the database's connection limit under any real traffic.
const auth = createAuthApi();
const store = createWorkspaceStore();
const handle = createWorkspaceApi({ store, auth });

export default async (request, response) => {
  if (!(await handle(request, response, "/api/workspace"))) response.writeHead(404).end();
};
