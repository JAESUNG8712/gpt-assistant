"use strict";

// 보안 종합 재검토(2026-08-24) 중 발견해 수정한 항목의 회귀 테스트.
//
// 1) /admin/fix-company-slug, /admin/inspect-collection, /admin/purge-company-collections
//    3개 마이그레이션 유틸리티가 x-migration-secret 헤더를 `!==` 평문 비교로 검증하고
//    있었다 — 이 파일의 다른 비밀값 비교(토큰 서명·BOOTSTRAP_SECRET·2FA)는 전부
//    crypto.timingSafeEqual을 쓰는데 이 세 라우트만 예외였고, 시도 횟수 제한도 전혀
//    없었다. _migrationSecretMatches()(constant-time) + migrationAdminLimiter(15분/20회)로
//    통일한 수정이 실제로 (a) 여전히 정상 동작하고 (b) 비밀값 없이/틀리게 보내면 404이며
//    (c) 반복 시도 시 실제로 429가 발생하는지 검증한다.
//    이 세 라우트는 app_collections(Postgres 전용 테이블)를 직접 조회/삭제하므로
//    JSON 파일 모드에서는 애초에 의미가 없다 — postgres-mode.test.js와 동일하게
//    DATABASE_URL이 없으면 전체를 건너뛴다.
// 2) POST /api/auth/2fa/verify-code에 rate limiter가 전혀 없었다(JSON 파일 모드에서도
//    재현되는 문제라 이 부분만 별도로, 항상 실행되는 스위트에서 검증한다) — loginLimiter를
//    적용해도 정상 호출은 계속 성공하고 반복된 실패만 카운트됨을 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
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

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!ADMIN_DATABASE_URL) {
  test("보안 하드닝: 마이그레이션 유틸리티 상수시간 비교 + rate limit (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  test("보안 하드닝: 마이그레이션 유틸리티 상수시간 비교 + rate limit", async (t) => {
    const dbName = `hrtest_migsec_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const base = ADMIN_DATABASE_URL.replace(/\/[^/]*(\?.*)?$/, "");
    const testDbUrl = `${base}/${dbName}`;

    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    t.after(async () => {
      try {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [dbName]
        );
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally {
        await admin.end();
      }
    });

    const server = await startServer({ env: { DATABASE_URL: testDbUrl, MIGRATION_ADMIN_SECRET: "test-migration-secret-value" } });
    t.after(() => server.stop());
    const api = (path, options) => fetch(server.baseUrl + path, options);

    await t.test("/admin/inspect-collection — 시크릿 미지정/오답은 404, 정답이면 200", async () => {
      const noHeader = await api("/admin/inspect-collection?collection=boardPosts");
      assert.equal(noHeader.status, 404);

      const wrongSecret = await api("/admin/inspect-collection?collection=boardPosts", {
        headers: { "x-migration-secret": "wrong-value" },
      });
      assert.equal(wrongSecret.status, 404);

      const correct = await api("/admin/inspect-collection?collection=boardPosts", {
        headers: { "x-migration-secret": "test-migration-secret-value" },
      });
      assert.equal(correct.status, 200);
      const body = await correct.json();
      assert.equal(body.ok, true);
      assert.equal(body.collection, "boardPosts");
    });

    await t.test("/admin/inspect-collection — 반복 오답 시도는 결국 429로 차단된다(브루트포스 방어)", async () => {
      let sawTooMany = false;
      for (let i = 0; i < 25; i++) {
        const r = await api("/admin/inspect-collection?collection=boardPosts", {
          headers: { "x-migration-secret": `guess-${i}` },
        });
        if (r.status === 429) { sawTooMany = true; break; }
        assert.equal(r.status, 404, `${i}번째 오답 시도는 404여야 함(429가 아니라면)`);
      }
      assert.equal(sawTooMany, true, "20회 넘게 틀린 시크릿을 보내면 429가 발생해야 함");
    });
  });
}
