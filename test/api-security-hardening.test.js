"use strict";

// 보안 종합 재검토(2026-08-24) 중 발견해 수정한 항목의 회귀 테스트.
//
// 1) /admin/fix-company-slug, /admin/inspect-collection, /admin/purge-company-collections는
//    company_id 백필 작업 종료 후 제거됐다. Express SPA fallback 때문에 제거된 URL이
//    index.html과 HTTP 200을 반환하면 모니터링·보안 검사가 이를 살아 있는 API로 오인하고,
//    향후 같은 경로가 우발적으로 재사용될 수도 있다. 세 URL이 파일/PostgreSQL 환경 및
//    x-migration-secret 값과 무관하게 항상 404인지 검증한다.
// 2) POST /api/auth/2fa/verify-code에 rate limiter가 전혀 없었다(JSON 파일 모드에서도
//    재현되는 문제라 이 부분만 별도로, 항상 실행되는 스위트에서 검증한다) — loginLimiter를
//    적용해도 정상 호출은 계속 성공하고 반복된 실패만 카운트됨을 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, startServerExpectingBootFailure } = require("./support/start-server");

test("보안 하드닝: 2FA verify-code에 rate limiter 적용(JSON 파일 모드에서도 검증 가능)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  await t.test("필수 파라미터 누락은 400, 형식이 틀린 OTP는 200+ok:false", async () => {
    const missing = await api("/api/auth/2fa/verify-code", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    const wrong = await api("/api/auth/2fa/verify-code", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "JBSWY3DPEHPK3PXP", otp: "000000" }),
    });
    assert.equal(wrong.status, 200);
    const wrongBody = await wrong.json();
    assert.equal(wrongBody.ok, false);
  });

  await t.test("반복된 실패 시도는 결국 429로 차단된다(loginLimiter 공유, 브루트포스 방어)", async () => {
    let sawTooMany = false;
    for (let i = 0; i < 25; i++) {
      const r = await api("/api/auth/2fa/verify-code", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: "JBSWY3DPEHPK3PXP", otp: String(100000 + i) }),
      });
      if (r.status === 429) { sawTooMany = true; break; }
    }
    assert.equal(sawTooMany, true, "잘못된 OTP를 반복 시도하면 429가 발생해야 함");
  });
});

test("보안 하드닝: 제거된 임시 관리자 API는 SPA fallback으로 우회되지 않는다", async (t) => {
    const server = await startServer({ env: { MIGRATION_ADMIN_SECRET: "test-migration-secret-value" } });
    t.after(() => server.stop());
    const api = (path, options) => fetch(server.baseUrl + path, options);

    for (const path of [
      "/admin/fix-company-slug",
      "/admin/inspect-collection?collection=boardPosts",
      "/admin/purge-company-collections",
    ]) {
      for (const secret of [undefined, "wrong-value", "test-migration-secret-value"]) {
        const headers = secret ? { "x-migration-secret": secret } : undefined;
        const response = await api(path, { method: "GET", headers });
        assert.equal(response.status, 404, `${path}는 secret과 무관하게 제거 상태여야 함`);
      }
    }
  });

test("보안 하드닝: production은 고정 SESSION_SECRET 없이는 부팅하지 않는다", async (t) => {
  const result = await startServerExpectingBootFailure({
    env: { NODE_ENV: "production", SESSION_SECRET: "" },
  });
  t.after(() => result.cleanup());

  assert.notEqual(result.exitCode, 0);
  assert.match(result.logs.stderr, /SESSION_SECRET/);
});

test("보안 하드닝: production은 짧은 SESSION_SECRET으로 부팅하지 않는다", async (t) => {
  const result = await startServerExpectingBootFailure({
    env: { NODE_ENV: "production", SESSION_SECRET: "short-secret" },
  });
  t.after(() => result.cleanup());

  assert.notEqual(result.exitCode, 0);
  assert.match(result.logs.stderr, /SESSION_SECRET/);
  assert.match(result.logs.stderr, /32/);
});

test("보안 하드닝: production CORS Origin 설정은 와일드카드와 잘못된 URL을 거부한다", async (t) => {
  for (const value of ["*", "not-a-url", "ftp://hr.example.com"]) {
    const result = await startServerExpectingBootFailure({
      env: {
        NODE_ENV: "production",
        SESSION_SECRET: "test-production-session-secret-for-origin-guardrails",
        ALLOWED_ORIGINS: value,
      },
    });
    t.after(() => result.cleanup());

    assert.notEqual(result.exitCode, 0, `${value} 설정은 운영 부팅을 막아야 함`);
    assert.match(result.logs.stderr, /CORS/);
  }
});

test("보안 하드닝: production CORS는 허용 출처만 응답한다", async (t) => {
  const server = await startServer({
    env: {
      NODE_ENV: "production",
      SESSION_SECRET: "test-production-session-secret-for-cors",
      ALLOWED_ORIGINS: "https://hr.example.com",
    },
  });
  t.after(() => server.stop());

  const noOrigin = await fetch(server.baseUrl + "/status");
  assert.equal(noOrigin.status, 200, "서버 간 호출/헬스체크처럼 Origin 없는 요청은 유지해야 함");

  const allowed = await fetch(server.baseUrl + "/status", {
    headers: { Origin: "https://hr.example.com" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://hr.example.com");

  const denied = await fetch(server.baseUrl + "/status", {
    headers: { Origin: "https://evil.example.com" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  assert.equal((await denied.json()).code, "CORS_ORIGIN_DENIED");

  const preflight = await fetch(server.baseUrl + "/login", {
    method: "OPTIONS",
    headers: {
      Origin: "https://hr.example.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://hr.example.com");
});

test("보안 하드닝: 개발/테스트 CORS는 로컬 브라우저 테스트 포트를 허용한다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const allowed = await fetch(server.baseUrl + "/status", {
    headers: { Origin: "http://127.0.0.1:4300" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://127.0.0.1:4300");
});
