const test = require("node:test");
const assert = require("node:assert/strict");
const map = require("../public/hr-function-map.js");

test("HR 업무지도는 첨부 구성도의 핵심 업무와 역할을 빠짐없이 구분한다", () => {
  const keys = new Set(map.AREAS.map(area => area.key));
  ["operations", "planning", "attendance", "learning", "payroll", "retirement", "settlement", "insurance", "welfare"].forEach(key => assert.ok(keys.has(key), key));
  assert.deepEqual(map.ROLE_LANES.map(role => role.key), ["executive", "director", "leader", "member", "hr"]);
});

test("기능 상태 집계는 전체 항목과 일치하고 외부연계·고도화 항목을 숨기지 않는다", () => {
  const counts = map.summary();
  assert.equal(counts.total, map.AREAS.reduce((sum, area) => sum + area.items.length, 0));
  assert.ok(counts.active > 0);
  assert.ok(counts.partial > 0);
  assert.ok(counts.external > 0);
  assert.ok(counts.planned > 0);
});
