import { createAuthApi } from "../../auth-api.mjs";

const auth = createAuthApi();
export default (request, response) => auth(request, response, "/api/auth/login");
