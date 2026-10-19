"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../support/start-server");
const http = require("node:http");
const express = require("express");
const { installAsyncRouteGuard } = require("../../lib/async-route-guard");

test("nested async middleware forwards rejection to four-argument error middleware", async t => {
  const app = installAsyncRouteGuard(express());
  app.get("/nested", [[async () => { throw new Error("nested failure"); }]]);
  app.use(async (err, req, res, next) => { await Promise.resolve(); res.status(503).json({ message: err.message }); });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/nested`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: "nested failure" });
});

test("Express 4 async route rejection returns 500 without hanging or killing server", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const failed = await fetch(`${server.baseUrl}/__test__/async-route-error`, { signal: AbortSignal.timeout(3000) });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { ok: false, code: "INTERNAL_ERROR", message: "요청을 처리하지 못했습니다." });
  const healthy = await fetch(`${server.baseUrl}/status`, { signal: AbortSignal.timeout(3000) });
  assert.equal(healthy.status, 200);
});
