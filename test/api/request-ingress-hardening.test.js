"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startServer } = require("../support/start-server");

function postChunkedJson(url, chunks) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
    }, res => {
      const parts = [];
      res.on("data", part => parts.push(part));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test("JSON ingress 크기 제한은 일반 API와 전체 저장·복원을 분리한다", async t => {
  const server = await startServer({
    env: {
      JSON_BODY_LIMIT_DEFAULT_BYTES: "1024",
      JSON_BODY_LIMIT_SAVE_BYTES: "4096",
      JSON_BODY_LIMIT_RESTORE_BYTES: "8192",
      INGRESS_RATE_LIMIT_ANON_MAX: "100",
    },
  });
  t.after(() => server.stop());

  await t.test("Content-Length가 명시된 일반 API 초과 요청을 JSON 413으로 즉시 거절", async () => {
    const response = await fetch(server.baseUrl + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "user", pw: "x".repeat(1300) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      message: "요청 데이터가 허용 크기를 초과했습니다.",
      maxBytes: 1024,
    });
  });

  await t.test("Content-Length가 없는 chunked 초과 요청도 실제 누적 크기로 차단", async () => {
    const response = await postChunkedJson(server.baseUrl + "/login", [
      '{"loginId":"user","pw":"',
      "x".repeat(1300),
      '"}',
    ]);
    assert.equal(response.status, 413);
    assert.equal(response.body.code, "PAYLOAD_TOO_LARGE");
    assert.equal(response.body.maxBytes, 1024);
  });

  await t.test("/save는 일반 한도를 넘더라도 저장 전용 한도 안이면 정상 라우팅", async () => {
    const response = await fetch(server.baseUrl + "/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filler: "x".repeat(1800) }),
    });
    assert.equal(response.status, 401);
    assert.notEqual((await response.json()).code, "PAYLOAD_TOO_LARGE");
  });

  await t.test("/save 전용 한도를 넘으면 413", async () => {
    const response = await fetch(server.baseUrl + "/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filler: "x".repeat(4500) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).maxBytes, 4096);
  });

  await t.test("/restore는 저장 한도보다 큰 요청도 복원 한도 안이면 정상 라우팅", async () => {
    const response = await fetch(server.baseUrl + "/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filler: "x".repeat(6000) }),
    });
    assert.equal(response.status, 401);
    assert.notEqual((await response.json()).code, "PAYLOAD_TOO_LARGE");
  });

  await t.test("/restore 전용 한도를 넘으면 413", async () => {
    const response = await fetch(server.baseUrl + "/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filler: "x".repeat(8500) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).maxBytes, 8192);
  });

  await t.test("잘못된 JSON은 HTML 대신 안정적인 JSON 400 계약으로 응답", async () => {
    const response = await fetch(server.baseUrl + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"loginId":',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      code: "INVALID_JSON",
      message: "JSON 요청 형식이 올바르지 않습니다.",
    });
  });
});

test("익명 쓰기 요청은 읽기 상태 확인과 별도로 ingress rate limit을 적용한다", async t => {
  const server = await startServer({ env: { INGRESS_RATE_LIMIT_ANON_MAX: "3" } });
  t.after(() => server.stop());

  // GET 상태 확인은 쓰기 한도를 소비하지 않는다.
  for (let i = 0; i < 5; i += 1) {
    const status = await fetch(server.baseUrl + "/status");
    assert.equal(status.status, 200);
  }

  for (let i = 0; i < 3; i += 1) {
    const response = await fetch(server.baseUrl + "/not-a-real-write-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.notEqual(response.status, 429);
  }
  const limited = await fetch(server.baseUrl + "/not-a-real-write-route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "REQUEST_RATE_LIMITED");
});
