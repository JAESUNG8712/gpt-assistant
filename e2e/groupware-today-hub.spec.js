const { test, expect } = require("@playwright/test");

test.describe("그룹웨어형 오늘의 업무 허브", () => {
  test("오늘의 근태·결재·일정·회의실·공지를 요약하고 원래 업무 화면으로 이동한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
    // 로그인 직후 서버의 전체 상태 적용이 끝난 뒤 테스트 데이터를 주입해야
    // 지연 도착한 응답이 approvalDocs/roomReservations/boardPosts를 덮어쓰지 않는다.
    await page.waitForTimeout(750);

    await page.evaluate(() => {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      currentUser.dashWidgets = ["today_work_hub"];
      currentUser.dashWidgetSizes = { today_work_hub: { cols: 8, rows: 6 } };
      currentUser.menuPerms = {};
      attendanceRecords = [{ id: "att-hub", empId: currentUser.id, date: today, checkIn: "09:03", status: "present" }];
      approvalDocs = [{
        id: "apv-hub", authorId: "hub-author", title: "법인카드 사용 승인", status: "in_progress",
        templateId: "tpl-expense", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        approvers: [{ empId: currentUser.id, status: "pending" }],
      }];
      scheduleEvents = [{ id: "sch-hub", authorId: currentUser.id, title: "주간 경영회의", scope: "personal", startDate: today, endDate: today, createdAt: new Date().toISOString() }];
      settings.meetingRooms = [{ id: "room-hub", name: "대회의실", capacity: 12, location: "3층" }];
      roomReservations = [{ id: "room-rsv-hub", roomId: "room-hub", bookedBy: currentUser.id, date: today, endDate: today, startTime: "14:00", endTime: "15:00", title: "프로젝트 회의" }];
      boardPosts = [{ id: "post-hub", categoryId: "notice", title: "전사 보안교육 안내", authorId: currentUser.id, createdAt: new Date().toISOString() }];
      _baseRenderDashboard();
    });

    const hub = page.getByTestId("today-work-hub");
    await expect(hub).toBeVisible();
    await expect(hub).toContainText("근무 중");
    await expect(hub).toContainText("결재 대기");
    await expect(hub).toContainText("주간 경영회의");
    await expect(hub).toContainText("14:00 대회의실");
    await expect(hub).toContainText("전사 보안교육 안내");

    await hub.locator('[data-hub-action="approval-inbox"]').click();
    await expect.poll(() => page.evaluate(() => currentPage)).toBe("approval-inbox");

    await page.evaluate(() => {
      currentUser.menuPerms = { "room-booking": false };
      currentUser.dashWidgets = ["today_work_hub"];
      _baseRenderDashboard();
    });
    await expect(page.getByTestId("today-work-hub")).not.toContainText("내 회의실");
    expect(pageErrors, `콘솔 페이지 에러 발생: ${pageErrors.join("; ")}`).toHaveLength(0);
  });
});
