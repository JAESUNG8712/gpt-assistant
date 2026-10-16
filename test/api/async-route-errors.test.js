"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../support/start-server");

test("Express 4 async route rejection returns 500 without hanging or killing server", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const failed = await fetch(`${server.baseUrl}/__test__/async-route-error`, { signal: AbortSignal.timeout(3000) });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { ok: false, code: "INTERNAL_ERROR", message: "요청을 처리하지 못했습니다." });
  const healthy = await fetch(`${server.baseUrl}/status`, { signal: AbortSignal.timeout(3000) });
  assert.equal(healthy.status, 200);
});
