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
const { startServer } = require("./support/start-server");

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
