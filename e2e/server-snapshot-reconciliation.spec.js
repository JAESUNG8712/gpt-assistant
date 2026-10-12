const { test, expect } = require("@playwright/test");

test.describe("서버 스냅샷과 로컬 변경 병합", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?demo=1");
  });

  test("서버에서 삭제한 행은 과거 로컬 timestamp가 더 최신이어도 되살리지 않는다", async ({ page }) => {
    const result = await page.evaluate(() => {
      _serverSnapshotIds = {};
      personalTasks = [];
      _applyServerSnapshot({ data: { personalTasks: [{ id: "removed", updatedAt: "2026-01-01", title: "서버 행" }] } }, true);
      personalTasks = [{ id: "removed", updatedAt: "2099-01-01", title: "오래된 로컬 캐시" }];
      _applyServerSnapshot({ data: { personalTasks: [] } }, true);
      return personalTasks.map(task => task.id);
    });
    expect(result).toEqual([]);
  });

  test("저장 대기 중에도 원격 삭제는 반영하고 아직 서버에 없는 신규 행은 지킨다", async ({ page }) => {
    const result = await page.evaluate(() => {
      _serverSnapshotIds = {};
      personalTasks = [];
      _applyServerSnapshot({ data: { personalTasks: [{ id: "removed", updatedAt: "2026-01-01" }] } }, true);
      personalTasks = [
        { id: "removed", updatedAt: "2099-01-01" },
        { id: "new-local", updatedAt: "2099-01-01" }
      ];
      _serverDebounceTimer = setTimeout(() => {}, 60000);
      try {
        _applyServerSnapshot({ data: { personalTasks: [] } }, true);
        return personalTasks.map(task => task.id);
      } finally {
        clearTimeout(_serverDebounceTimer);
        _serverDebounceTimer = null;
      }
    });
    expect(result).toEqual(["new-local"]);
  });

  test("저장 대기가 끝난 뒤 거부된 로컬 삭제 표식은 서버 행을 계속 숨기지 않는다", async ({ page }) => {
    const result = await page.evaluate(() => {
      personalTasks = [];
      recordTombstones = { personalTasks: [{ id: "still-here", ts: Date.now() }] };
      _applyServerSnapshot({ data: {
        personalTasks: [{ id: "still-here", updatedAt: "2026-01-01" }],
        recordTombstones: {}
      } }, true);
      return {
        rows: personalTasks.map(task => task.id),
        tombstones: recordTombstones.personalTasks || []
      };
    });
    expect(result).toEqual({ rows: ["still-here"], tombstones: [] });
  });

  test("권한 회수 시 기존 보호 자료와 이전 권한의 저장 대기를 폐기한다", async ({ page }) => {
    const result = await page.evaluate(() => {
      _serverSnapshotIds = {};
      currentUser = { id: "admin-test", role: "admin", active: true, menuPerms: {} };
      employees = [currentUser];
      employmentRecords = [{ id: "private", updatedAt: "2099-01-01" }];
      _serverDebounceTimer = setTimeout(() => {}, 60000);
      _applyServerSnapshot({ data: {
        employees: [{ ...currentUser, menuPerms: { "employment-records": false } }],
        employmentRecords: []
      } }, true);
      return {
        cachedRows: employmentRecords.length,
        denied: currentUser.menuPerms["employment-records"],
        pendingTimer: Boolean(_serverDebounceTimer),
        page: currentPage
      };
    });
    expect(result.cachedRows).toBe(0);
    expect(result.denied).toBe(false);
    expect(result.pendingTimer).toBe(false);
  });
});
