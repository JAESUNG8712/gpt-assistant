"use strict";
const test = require("node:test");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");
const { exerciseTwoFactor } = require("./support/two-factor-flow");
test("2단계 인증은 본인 검증·동시 요청·세션 철회와 일반 저장 보존을 보장한다", async t => {
  const server = await startServer(); t.after(() => server.stop());
  const { token } = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "AdminPassword123" });
  await exerciseTwoFactor((p, o) => fetch(server.baseUrl + p, o), token);
});
