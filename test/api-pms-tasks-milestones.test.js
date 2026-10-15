"use strict";

// 작업5(항목A) — PMS 프로젝트 작업(Task)/마일스톤. 조회는 _pmsCanViewProject(), 변경은
// _pmsCanManageProject() — 프로젝트 자신의 CRUD와 동일한 권한 모델을 그대로 재사용한다.
// id는 항상 서버 생성(pms_worklogs와 동일한 단순 PK 패턴). JSON 파일 모드는 임시 파일+
// 랜덤 포트의 child process만 사용, 실제 데이터나 외부 DB를 건드리지 않는다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

async function login(api, loginId, pw, companyCode) {
  const r = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw, ...(companyCode ? { companyCode } : {}) }),
  })).json();
  assert.equal(r.ok, true, `${loginId} 로그인 실패: ${JSON.stringify(r)}`);
  return r.token;
}
function auth(token, method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}
async function getData(api, token) {
  const r = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(r.ok, true);
  return r;
}

test("PMS 작업/마일스톤 — 권한(조회=뷰어 전원, 변경=PM/admin)·낙관적 동시성·값검증·예산 자동산정", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "ldr-a", loginId: "ldra", pw: "ldr-a-test-pw", name: "팀장A", role: "leader", active: true, dept: "개발본부", team: "플랫폼팀", salary: 60000000 },
    { id: "ldr-b", loginId: "ldrb", pw: "ldr-b-test-pw", name: "팀장B(무관)", role: "leader", active: true, dept: "개발본부", team: "데이터팀" },
    { id: "mem-a", loginId: "mema", pw: "mem-a-test-pw", name: "팀원A", role: "member", active: true, dept: "개발본부", team: "플랫폼팀", salary: 48000000 },
    { id: "mem-c", loginId: "memc", pw: "mem-c-test-pw", name: "팀원C(무관)", role: "member", active: true, dept: "영업본부", team: "국내영업팀" },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees }));
  assert.equal(seed.status, 200);

  const ldrAToken = await login(api, "ldra", "ldr-a-test-pw");
  const ldrBToken = await login(api, "ldrb", "ldr-b-test-pw");
  const memAToken = await login(api, "mema", "mem-a-test-pw");
  const memCToken = await login(api, "memc", "mem-c-test-pw");

  const projRes = await api("/api/pms/projects", auth(ldrAToken, "POST", { name: "플랫폼 프로젝트", pmId: "ldr-a", members: ["mem-a"] }));
  assert.equal(projRes.status, 200);
  const project = (await projRes.json()).project;

  await t.test("존재하지 않는 프로젝트의 작업 목록 조회는 404", async () => {
    const r = await api("/api/pms/projects/no-such-project/tasks", { headers: { Authorization: `Bearer ${ldrAToken}` } });
    assert.equal(r.status, 404);
  });

  await t.test("프로젝트와 무관한 사용자는 작업 목록을 볼 수 없다(403)", async () => {
    const r = await api(`/api/pms/projects/${project.id}/tasks`, { headers: { Authorization: `Bearer ${memCToken}` } });
    assert.equal(r.status, 403);
  });

  await t.test("프로젝트 멤버(mem-a)는 작업 목록을 볼 수 있다(빈 배열)", async () => {
    const r = await api(`/api/pms/projects/${project.id}/tasks`, { headers: { Authorization: `Bearer ${memAToken}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.tasks, []);
  });

  await t.test("무관한 팀장(ldr-b)은 작업을 생성할 수 없다(403, PM/생성자 아님)", async () => {
    const r = await api(`/api/pms/projects/${project.id}/tasks`, auth(ldrBToken, "POST", { title: "탈취 시도" }));
    assert.equal(r.status, 403);
  });

  await t.test("작업명 없이 생성 시도하면 400", async () => {
    const r = await api(`/api/pms/projects/${project.id}/tasks`, auth(ldrAToken, "POST", { title: "" }));
    assert.equal(r.status, 400);
  });

  let task;
  await t.test("PM(ldr-a)은 작업을 생성할 수 있고, 잘못된 status/priority는 기본값으로 떨어진다", async () => {
    const r = await api(`/api/pms/projects/${project.id}/tasks`, auth(ldrAToken, "POST", {
      title: "설계 문서 작성", assigneeId: "mem-a", status: "no-such-status", priority: "urgent-nonsense", dueDate: "2026-12-31",
    }));
    assert.equal(r.status, 200);
    task = (await r.json()).task;
    assert.equal(task.title, "설계 문서 작성");
    assert.equal(task.assigneeId, "mem-a");
    assert.equal(task.status, "todo");
    assert.equal(task.priority, "normal");
    assert.equal(task.dueDate, "2026-12-31");
    assert.equal(task.projectId, project.id);
  });

  await t.test("admin은 임의 프로젝트의 작업을 관리할 수 있다", async () => {
    const r = await api(`/api/pms/projects/${project.id}/tasks/${task.id}`, auth(adminToken, "POST", { status: "in_progress" }));
    assert.equal(r.status, 200);
    const updated = (await r.json()).task;
    assert.equal(updated.status, "in_progress");
    task = updated;
  });

  await t.test("오래된 expectedUpdatedAt으로 수정하면 409 PMS_TASK_CONFLICT, 다른 필드 변경은 반영되지 않는다", async () => {
    const stale = task.updatedAt;
    const first = await api(`/api/pms/projects/${project.id}/tasks/${task.id}`, auth(ldrAToken, "POST", { title: "먼저 저장", expectedUpdatedAt: stale }));
    assert.equal(first.status, 200);
    task = (await first.json()).task;

    const conflict = await api(`/api/pms/projects/${project.id}/tasks/${task.id}`, auth(ldrAToken, "POST", { title: "오래된 탭의 변경", expectedUpdatedAt: stale }));
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.equal(body.code, "PMS_TASK_CONFLICT");
    assert.equal(body.task.title, "먼저 저장");
  });

  await t.test("다른 프로젝트 id로 같은 작업을 수정 시도하면 404(projectId 불일치 방어)", async () => {
    const otherRes = await api("/api/pms/projects", auth(ldrBToken, "POST", { name: "데이터 프로젝트", pmId: "ldr-b" }));
    const other = (await otherRes.json()).project;
    const r = await api(`/api/pms/projects/${other.id}/tasks/${task.id}`, auth(ldrBToken, "POST", { title: "오염 시도" }));
    assert.equal(r.status, 404);
  });

  await t.test("무관한 팀장은 작업을 삭제할 수 없다(403)", async () => {
    const r = await api(`/api/pms/projects/${project.id}/tasks/${task.id}/delete`, auth(ldrBToken, "POST", {}));
    assert.equal(r.status, 403);
  });

  await t.test("PM은 작업을 삭제할 수 있고, 삭제 후 목록에서 사라진다", async () => {
    const r = await api(`/api/pms/projects/${project.id}/tasks/${task.id}/delete`, auth(ldrAToken, "POST", {}));
    assert.equal(r.status, 200);
    const list = await (await api(`/api/pms/projects/${project.id}/tasks`, { headers: { Authorization: `Bearer ${ldrAToken}` } })).json();
    assert.deepEqual(list.tasks, []);
  });

  await t.test("존재하지 않는 작업 삭제/수정은 404", async () => {
    const del = await api(`/api/pms/projects/${project.id}/tasks/no-such-task/delete`, auth(ldrAToken, "POST", {}));
    assert.equal(del.status, 404);
    const upd = await api(`/api/pms/projects/${project.id}/tasks/no-such-task`, auth(ldrAToken, "POST", { title: "x" }));
    assert.equal(upd.status, 404);
  });

  // ── 마일스톤 ────────────────────────────────────────────────────────────
  let milestone;
  await t.test("마일스톤명 없이 생성 시도하면 400, 정상 생성 시 status 기본값은 pending", async () => {
    const bad = await api(`/api/pms/projects/${project.id}/milestones`, auth(ldrAToken, "POST", { title: "" }));
    assert.equal(bad.status, 400);
    const r = await api(`/api/pms/projects/${project.id}/milestones`, auth(ldrAToken, "POST", { title: "1차 릴리스", dueDate: "2026-11-30", description: "베타 출시" }));
    assert.equal(r.status, 200);
    milestone = (await r.json()).milestone;
    assert.equal(milestone.status, "pending");
    assert.equal(milestone.description, "베타 출시");
  });

  await t.test("무관한 팀장은 마일스톤을 수정할 수 없다(403)", async () => {
    const r = await api(`/api/pms/projects/${project.id}/milestones/${milestone.id}`, auth(ldrBToken, "POST", { status: "done" }));
    assert.equal(r.status, 403);
  });

  await t.test("PM은 마일스톤 상태를 done으로 전환할 수 있고, 오래된 탭 재시도는 409 PMS_MILESTONE_CONFLICT", async () => {
    const stale = milestone.updatedAt;
    const r = await api(`/api/pms/projects/${project.id}/milestones/${milestone.id}`, auth(ldrAToken, "POST", { status: "done", expectedUpdatedAt: stale }));
    assert.equal(r.status, 200);
    milestone = (await r.json()).milestone;
    assert.equal(milestone.status, "done");

    const conflict = await api(`/api/pms/projects/${project.id}/milestones/${milestone.id}`, auth(ldrAToken, "POST", { status: "pending", expectedUpdatedAt: stale }));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "PMS_MILESTONE_CONFLICT");
  });

  await t.test("PM은 마일스톤을 삭제할 수 있다", async () => {
    const r = await api(`/api/pms/projects/${project.id}/milestones/${milestone.id}/delete`, auth(ldrAToken, "POST", {}));
    assert.equal(r.status, 200);
    const list = await (await api(`/api/pms/projects/${project.id}/milestones`, { headers: { Authorization: `Bearer ${ldrAToken}` } })).json();
    assert.deepEqual(list.milestones, []);
  });

  // ── 예산 자동산정 ────────────────────────────────────────────────────────
  await t.test("예산: budgetPlanned 기본값 0, worklog 없으면 actualCost 0", async () => {
    const r = await api(`/api/pms/projects/${project.id}/budget`, { headers: { Authorization: `Bearer ${ldrAToken}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.budgetPlanned, 0);
    assert.equal(body.actualCost, 0);
    assert.equal(body.totalHours, 0);
    assert.equal(body.standardMonthlyHours, 174);
  });

  await t.test("예산: 계획예산 저장 반영 + 업무일지 기준 실적비용 손계산 대조", async () => {
    const setBudget = await api(`/api/pms/projects/${project.id}`, auth(ldrAToken, "POST", { budgetPlanned: 10000000 }));
    assert.equal(setBudget.status, 200);

    // ldr-a: 연봉 6천만원 → 월급 500만원 → 시급 500만/174h ≈ 28735.63원. mem-a: 연봉 4800만원
    // → 월급 400만원 → 시급 400만/174h ≈ 22988.51원. 각자 2시간씩 이 프로젝트에 투입.
    const wlA = await api("/api/pms/worklogs", auth(ldrAToken, "POST", {
      employeeId: "ldr-a", date: "2026-09-01", blocks: [{ projectId: project.id, task: "설계", startTime: "09:00", endTime: "11:00" }],
    }));
    assert.equal(wlA.status, 200);
    const wlB = await api("/api/pms/worklogs", auth(memAToken, "POST", {
      employeeId: "mem-a", date: "2026-09-01", blocks: [{ projectId: project.id, task: "구현", startTime: "13:00", endTime: "15:00" }],
    }));
    assert.equal(wlB.status, 200);

    const r = await api(`/api/pms/projects/${project.id}/budget`, { headers: { Authorization: `Bearer ${ldrAToken}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.budgetPlanned, 10000000);
    assert.equal(body.totalHours, 4);
    const expectedCost = Math.round(2 * (6_0000_000 / 12 / 174) + 2 * (4_800_0000 / 12 / 174));
    assert.equal(body.actualCost, expectedCost, `실적비용 손계산 대조 실패: 기대값=${expectedCost}, 실제=${body.actualCost}`);
  });

  await t.test("예산: pmsStandardMonthlyHours 설정값을 반영한다", async () => {
    const d = await getData(api, adminToken);
    const settings = { ...(d.data.settings || {}), pmsStandardMonthlyHours: 200 };
    const saveSettings = await api("/save", auth(adminToken, "POST", { _version: d.version, settings, _singletonRevisions: d.data._singletonRevisions }));
    assert.equal(saveSettings.status, 200);

    const r = await api(`/api/pms/projects/${project.id}/budget`, { headers: { Authorization: `Bearer ${ldrAToken}` } });
    const body = await r.json();
    assert.equal(body.standardMonthlyHours, 200);
    const expectedCost = Math.round(2 * (6_0000_000 / 12 / 200) + 2 * (4_800_0000 / 12 / 200));
    assert.equal(body.actualCost, expectedCost);
  });

  await t.test("예산: 무관한 사용자는 조회할 수 없다(403)", async () => {
    const r = await api(`/api/pms/projects/${project.id}/budget`, { headers: { Authorization: `Bearer ${memCToken}` } });
    assert.equal(r.status, 403);
  });
});

// Postgres 모드 전용 검증 — 매 아이템 트랜잭션 락 기반 수정, project_id/company_id
// 복합 스코프, 멀티테넌트 격리는 JSON 모드로는 전혀 가지 않는 코드 경로다.
const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("PMS 작업/마일스톤 — Postgres 모드 (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");

  test("PMS 작업/마일스톤이 실제 PostgreSQL(운영 모드)에서도 멀티테넌트 격리·낙관적 동시성을 지킨다", async (t) => {
    const dbName = `hrtest_pmstasks_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const base = ADMIN_DATABASE_URL.replace(/\/[^/]*(\?.*)?$/, "");
    const testDbUrl = `${base}/${dbName}`;
    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    t.after(async () => {
      try {
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [dbName]);
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally {
        await admin.end();
      }
    });

    const server = await startServer({ env: { DATABASE_URL: testDbUrl } });
    t.after(() => server.stop());
    const api = (path, options) => fetch(server.baseUrl + path, options);

    const regA = await (await api("/api/companies/register", auth(null, "POST", {
      companyName: "PMS작업테스트A", adminName: "관리자A", loginId: "admin_pmsA", password: "AdminPassw0rd1",
    }))).json();
    assert.equal(regA.ok, true);
    const regB = await (await api("/api/companies/register", auth(null, "POST", {
      companyName: "PMS작업테스트B", adminName: "관리자B", loginId: "admin_pmsB", password: "AdminPassw0rd1",
    }))).json();
    assert.equal(regB.ok, true);

    const projARes = await api("/api/pms/projects", auth(regA.token, "POST", { name: "A회사 프로젝트" }));
    assert.equal(projARes.status, 200);
    const projA = (await projARes.json()).project;

    const taskRes = await api(`/api/pms/projects/${projA.id}/tasks`, auth(regA.token, "POST", { title: "A회사 작업" }));
    assert.equal(taskRes.status, 200);
    const task = (await taskRes.json()).task;

    await t.test("회사B 토큰은 회사A의 프로젝트/작업을 전혀 볼 수 없다(404, 존재 자체를 노출하지 않음)", async () => {
      const r = await api(`/api/pms/projects/${projA.id}/tasks`, { headers: { Authorization: `Bearer ${regB.token}` } });
      assert.equal(r.status, 404);
    });

    await t.test("회사B 토큰은 회사A의 작업을 수정/삭제할 수 없다(404)", async () => {
      const upd = await api(`/api/pms/projects/${projA.id}/tasks/${task.id}`, auth(regB.token, "POST", { title: "탈취" }));
      assert.equal(upd.status, 404);
      const del = await api(`/api/pms/projects/${projA.id}/tasks/${task.id}/delete`, auth(regB.token, "POST", {}));
      assert.equal(del.status, 404);
    });

    await t.test("Postgres 모드에서도 낙관적 동시성(SELECT...FOR UPDATE 기반)이 정상 동작한다", async () => {
      const stale = task.updatedAt;
      const first = await api(`/api/pms/projects/${projA.id}/tasks/${task.id}`, auth(regA.token, "POST", { title: "먼저 저장", expectedUpdatedAt: stale }));
      assert.equal(first.status, 200);
      const conflict = await api(`/api/pms/projects/${projA.id}/tasks/${task.id}`, auth(regA.token, "POST", { title: "오래된 탭", expectedUpdatedAt: stale }));
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).code, "PMS_TASK_CONFLICT");
    });

    await t.test("Postgres 모드에서 10건 동시 작업 생성이 전부 유실 없이 저장된다", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          api(`/api/pms/projects/${projA.id}/tasks`, auth(regA.token, "POST", { title: `동시작업-${i}` }))
        )
      );
      assert.ok(results.every(r => r.status === 200));
      const list = await (await api(`/api/pms/projects/${projA.id}/tasks`, { headers: { Authorization: `Bearer ${regA.token}` } })).json();
      // 기존 "A회사 작업" 1건 + 방금 "먼저 저장"으로 제목이 바뀐 task(동일 레코드) + 신규 10건.
      assert.equal(list.tasks.length, 11);
      const titles = new Set(list.tasks.map(t => t.title));
      for (let i = 0; i < 10; i++) assert.ok(titles.has(`동시작업-${i}`), `동시작업-${i}가 유실됨`);
    });
  });
}
