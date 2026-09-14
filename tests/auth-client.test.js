import test from "node:test";
import assert from "node:assert/strict";
import { AuthClient } from "../auth-client.js";

test("a pending profile refresh cannot restore signed-in UI after logout", async () => {
  const client = new AuthClient({ onChange: () => {} });
  const calls = [];
  let release;
  client.request = async (path) => {
    calls.push(path);
    if (path === "session") return new Promise((resolve) => { release = resolve; });
    return { logoutUrl: "https://api.workos.com/user_management/sessions/logout" };
  };
  const refresh = client.refresh();
  const logout = client.logout();
  assert.deepEqual(calls, ["session"], "Logout must wait for the earlier session request.");
  release({ configured: true, authenticated: true, user: { id: "user_fixture", email: "coven@example.test" } });
  await refresh;
  await logout;
  assert.deepEqual(calls, ["session", "logout"]);
  assert.equal(client.state.phase, "signed-out");
});
