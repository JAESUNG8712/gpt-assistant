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

test("보안 하드닝: API 경로 대소문자 변형은 라우트·권한 미들웨어·SPA fallback을 우회하지 못한다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  for (const path of [
    "/STATUS",
    "/DATA",
    "/LOGIN",
    "/EVENTS",
    "/MASTER/feature-catalog",
    "/API/Accounting/Accounts",
    "/Api/Pms/Projects",
    "/api/ERP/Stock",
    "/api/Recruit/Jobs",
  ]) {
    const response = await fetch(server.baseUrl + path, {
      method: path === "/LOGIN" ? "POST" : "GET",
      headers: path === "/LOGIN" ? { "Content-Type": "application/json" } : undefined,
      body: path === "/LOGIN" ? "{}" : undefined,
    });
    assert.equal(response.status, 404, `${path}는 대소문자 불일치로 404여야 함`);
    assert.match(response.headers.get("content-type") || "", /application\/json/);
    const body = await response.json();
    assert.equal(body.code, "API_PATH_CASE_MISMATCH");
  }
});

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

// 2026-08-30 실사용자 신고("회사 만들기"/admin 로그인 둘 다 "허용되지 않은 요청
// 출처입니다"로 실패)로 발견: render.yaml이 의도한 배포(index.html과 API를 같은
// Render 서비스가 함께 서빙)는 ALLOWED_ORIGINS를 아무것도 설정하지 않는데, 최신
// 브라우저는 완전히 같은 오리진의 POST 요청에도 Origin 헤더를 함께 보낸다 — 그
// Origin이 명시적 허용 목록에 없다는 이유만으로 진짜 같은 오리진 요청까지 CORS로
// 막히고 있었다. 명시 설정 없이도 "요청이 도착한 호스트 자신과 Origin이 일치하면"
// 항상 허용하도록 고쳤다 — 이 테스트는 그 시나리오를 정확히 재현한다.
test("보안 하드닝: ALLOWED_ORIGINS 미설정이어도 진짜 같은 오리진의 쓰기 요청은 CORS로 막히지 않는다", async (t) => {
  const server = await startServer({
    env: { NODE_ENV: "production", SESSION_SECRET: "test-production-session-secret-for-same-origin-cors" },
  });
  t.after(() => server.stop());
  const sameOriginHeader = `http://${new URL(server.baseUrl).host}`;

  const sameOriginPost = await fetch(server.baseUrl + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: sameOriginHeader },
    body: JSON.stringify({ loginId: "no-such-user", pw: "wrong-password" }),
  });
  const sameOriginBody = await sameOriginPost.json();
  assert.notEqual(sameOriginBody.code, "CORS_ORIGIN_DENIED", "진짜 같은 오리진 요청이 CORS로 거부됨");
  assert.equal(sameOriginPost.status, 200, "CORS를 통과했다면 로그인 자격 검증(틀린 비밀번호) 단계까지 도달해야 함");

  // 여전히 진짜 다른 오리진(요청이 도착한 호스트와 다름)은 명시적으로 허용하지 않은 이상 거부돼야 한다.
  const crossOriginPost = await fetch(server.baseUrl + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
    body: JSON.stringify({ loginId: "no-such-user", pw: "wrong-password" }),
  });
  assert.equal(crossOriginPost.status, 403);
  assert.equal((await crossOriginPost.json()).code, "CORS_ORIGIN_DENIED");
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

test("보안 하드닝: SSE 온라인 표시명은 query.user가 아니라 인증된 직원명으로 고정된다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const boot = await fetch(server.baseUrl + "/api/bootstrap/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bootstrap-Secret": "test-bootstrap-secret" },
    body: JSON.stringify({ loginId: "sse_admin", pw: "sse-admin-password", name: "서버검증관리자" }),
  });
  assert.equal(boot.status, 201);

  const login = await (await fetch(server.baseUrl + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId: "sse_admin", pw: "sse-admin-password" }),
  })).json();
  assert.equal(login.ok, true);

  const ticket = await (await fetch(server.baseUrl + "/events/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
    body: "{}",
  })).json();
  assert.equal(ticket.ok, true);

  const controller = new AbortController();
  const events = await fetch(
    server.baseUrl + `/events?clientId=spoof-client&user=${encodeURIComponent("대표이사 위조")}&token=${encodeURIComponent(ticket.token)}`,
    { signal: controller.signal }
  );
  t.after(() => controller.abort());
  assert.equal(events.status, 200);

  const online = await (await fetch(server.baseUrl + "/online", {
    headers: { Authorization: `Bearer ${login.token}` },
  })).json();
  assert.equal(online.ok, true);
  const row = online.users.find(u => u.clientId === "spoof-client");
  assert.ok(row);
  assert.equal(row.user, "서버검증관리자");
});

// 2026-08-27 병행 세션 감사에서 발견·수정: POST /events/token이 발급하는 5분짜리
// scope:"sse" 티켓은 GET /events 전용으로 설계됐는데(그 라우트 주석 참고), authenticate()가
// scope를 전혀 확인하지 않아 이 티켓을 그대로 Authorization: Bearer 헤더에 실으면 유효
// 기간(5분) 동안 다른 어떤 API도 완전한 사용자 권한으로 호출할 수 있었다 — 설계 의도
// ("다른 API에서는 재사용 불가")와 어긋나는 실제 공격면 확대였다(실측 확인).
test("보안 하드닝: SSE 전용 티켓(scope:sse)은 /events 외의 API를 인증하지 못한다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const boot = await fetch(server.baseUrl + "/api/bootstrap/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bootstrap-Secret": "test-bootstrap-secret" },
    body: JSON.stringify({ loginId: "sse_scope_admin", pw: "sse-scope-password", name: "SSE스코프관리자" }),
  });
  assert.equal(boot.status, 201);

  const login = await (await fetch(server.baseUrl + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId: "sse_scope_admin", pw: "sse-scope-password" }),
  })).json();
  assert.equal(login.ok, true);

  const ticket = await (await fetch(server.baseUrl + "/events/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
    body: "{}",
  })).json();
  assert.equal(ticket.ok, true);

  await t.test("SSE 티켓을 다른 API에 Bearer 헤더로 재사용하면 미인증으로 처리된다", async () => {
    const abused = await fetch(server.baseUrl + "/data", {
      headers: { Authorization: `Bearer ${ticket.token}` },
    });
    assert.equal(abused.status, 401);
  });

  await t.test("정상 흐름(쿼리스트링으로 /events 접속)은 계속 정상 동작한다", async () => {
    const controller = new AbortController();
    const events = await fetch(server.baseUrl + `/events?token=${encodeURIComponent(ticket.token)}`, {
      signal: controller.signal,
    });
    controller.abort();
    assert.equal(events.status, 200);
  });

  await t.test("일반 로그인 토큰은 계속 모든 API를 정상 인증한다(과잉차단 아님)", async () => {
    const normal = await fetch(server.baseUrl + "/data", {
      headers: { Authorization: `Bearer ${login.token}` },
    });
    assert.equal(normal.status, 200);
  });
});

test("보안 하드닝: 동시편집 잠금은 body.userName 위조와 타인 unlock을 허용하지 않는다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const boot = await fetch(server.baseUrl + "/api/bootstrap/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bootstrap-Secret": "test-bootstrap-secret" },
    body: JSON.stringify({ loginId: "lock_admin", pw: "lock-admin-password", name: "잠금관리자" }),
  });
  assert.equal(boot.status, 201);

  const adminLogin = await (await fetch(server.baseUrl + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId: "lock_admin", pw: "lock-admin-password" }),
  })).json();
  assert.equal(adminLogin.ok, true);

  const initial = await (await fetch(server.baseUrl + "/data", {
    headers: { Authorization: `Bearer ${adminLogin.token}` },
  })).json();
  const seed = await fetch(server.baseUrl + "/save", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminLogin.token}` },
    body: JSON.stringify({
      _version: initial.version,
      data: {
        ...initial.data,
        employees: [
          ...initial.data.employees,
          { id: "lock-member", loginId: "lock_member", pw: "lock-member-password", role: "member", name: "잠금일반사용자", empNo: "L2", active: true },
        ],
      },
    }),
  });
  assert.equal(seed.status, 200);

  const memberLogin = await (await fetch(server.baseUrl + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId: "lock_member", pw: "lock-member-password" }),
  })).json();
  assert.equal(memberLogin.ok, true);

  const lock = await (await fetch(server.baseUrl + "/lock", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminLogin.token}` },
    body: JSON.stringify({ key: "emp:lock-test", userId: "admin-tab", userName: "대표이사 위조", targetLabel: "직원 수정" }),
  })).json();
  assert.equal(lock.ok, true);
  assert.equal(lock.lock.userId, "admin-tab", "프론트 탭 식별자는 호환을 위해 유지한다");
  assert.equal(lock.lock.userName, "잠금관리자", "표시명은 인증된 직원명이어야 한다");

  const spoofUnlock = await fetch(server.baseUrl + "/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberLogin.token}` },
    body: JSON.stringify({ key: "emp:lock-test", userId: "admin-tab", userName: "잠금관리자" }),
  });
  assert.equal(spoofUnlock.status, 200);

  const conflict = await (await fetch(server.baseUrl + "/lock", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberLogin.token}` },
    body: JSON.stringify({ key: "emp:lock-test", userId: "member-tab", userName: "잠금일반사용자" }),
  })).json();
  assert.equal(conflict.ok, false, "타인이 userId를 맞춰 보내도 기존 잠금은 풀리지 않아야 한다");
  assert.equal(conflict.lock.userName, "잠금관리자");
});
