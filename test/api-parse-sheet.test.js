// lib/parse-sheet.js의 parseSheet() — 예산/사업계획 엑셀 업로드 라우트 5개(POST /upload/headcount,
// /upload/detail, /business-plan/:id/cost-block-upload, /business-plan/sga-upload/parse,
// /business-plan/headcount-plan/upload)가 전부 이 함수 하나를 거쳐간다. 지금 쓰는
// xlsx@0.18.5는 npm audit에 걸린 취약점(prototype pollution + ReDoS, 패치판은 npm
// 레지스트리에 없고 SheetJS 자사 CDN에만 있음)이 있어 언젠가 버전을 올려야 하는데,
// parseSheet()를 실제로 호출해 검증하는 테스트가 지금까지 하나도 없었다 — 버전을 올렸을 때
// 이 함수의 동작(멀티시트 자동탐지, `!ref` 시작행 오프셋 보정, excludedHeaders, 20행 스캔
// 한도, OR/AND 헤더 매칭 시맨틱)이 조용히 달라져도 자동으로는 전혀 알 수 없는 상태였다.
// 이 파일은 xlsx 패키지 자체로 워크북을 즉석에서 생성해(고정 바이너리 파일을 커밋하지
// 않음, file-mode.test.js가 PDF/DOCX를 직접 바이트로 구성하는 것과 동일한 관례)
// parseSheet()가 실제로 무엇을 반환하는지 잠그는 회귀 테스트다 — xlsx 버전을 올릴 때
// `npm test`만 돌려봐도 이 동작들이 그대로인지 확인된다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const xlsx = require("xlsx");
const { parseSheet } = require("../lib/parse-sheet");

function buildWorkbookBuffer(sheets) {
  const wb = xlsx.utils.book_new();
  for (const s of sheets) {
    const ws = xlsx.utils.aoa_to_sheet(s.rows);
    xlsx.utils.book_append_sheet(wb, ws, s.name);
  }
  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
}

// 시트 상단 몇 행이 "완전히 비어있는"(빈 문자열이 아니라 셀 자체가 없는) 경우를 재현한다 —
// 실제 회사 원본 파일의 "조직별" 시트가 이런 형태였다(!ref가 "A2:V91"처럼 0행이 아닌 곳부터
// 시작). aoa_to_sheet에 처음부터 빈 배열을 채워 넣으면 SheetJS가 그 셀들을 여전히 !ref
// 범위 안(그냥 값이 없는 셀)으로 잡을 수 있어, sheet_add_aoa로 origin을 지정해 앞쪽 행 자체가
// 워크시트에 존재하지 않도록 만든다.
function buildWorkbookWithOffset(name, rows, originCell) {
  const wb = xlsx.utils.book_new();
  const ws = {};
  xlsx.utils.sheet_add_aoa(ws, rows, { origin: originCell });
  xlsx.utils.book_append_sheet(wb, ws, name);
  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
}

test("parseSheet() — 레거시 경로(requiredHeaderGroups 생략): 첫 시트 첫 행을 헤더로 사용", () => {
  const buf = buildWorkbookBuffer([{ name: "Sheet1", rows: [["이름", "금액"], ["홍길동", 1000]] }]);
  const rows = parseSheet(buf, "test.xlsx");
  assert.deepEqual(rows, [{ 이름: "홍길동", 금액: 1000 }]);
});

test("parseSheet() — CSV 파일 경로(문자열로 파싱)도 동일하게 동작한다", () => {
  const csvBuf = Buffer.from("이름,금액\n홍길동,1000\n", "utf8");
  const rows = parseSheet(csvBuf, "test.csv");
  assert.deepEqual(rows, [{ 이름: "홍길동", 금액: 1000 }]);
});

test("parseSheet() — 멀티시트: 필요한 헤더가 있는 시트를 자동으로 찾아낸다(실제 사업계획 sga-upload 시나리오)", () => {
  const buf = buildWorkbookBuffer([
    { name: "RAW자료", rows: [["사번", "이름"], ["E1", "홍길동"]] },
    { name: "예산", rows: [["팀명", "항목", "1월"], ["인사팀", "통신비", 90000]] },
  ]);
  const rows = parseSheet(buf, "test.xlsx", [["팀명", "팀"], ["항목"]]);
  assert.equal(rows._sheetName, "예산");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["팀명"], "인사팀");
  assert.equal(rows[0]["1월"], 90000);
});

test("parseSheet() — 헤더 그룹 내 OR 시맨틱: '팀명' 대신 '팀'이어도 매칭된다", () => {
  const buf = buildWorkbookBuffer([{ name: "S", rows: [["팀", "항목", "1월"], ["영업1팀", "소모품비", 50000]] }]);
  const rows = parseSheet(buf, "t.xlsx", [["팀명", "팀"], ["항목"]]);
  assert.equal(rows._sheetName, "S");
  assert.equal(rows[0]["팀"], "영업1팀");
});

test("parseSheet() — 헤더 그룹 간 AND 시맨틱: 그룹 중 하나라도 매칭 실패하면 그 행/시트는 채택되지 않는다", () => {
  const buf = buildWorkbookBuffer([{ name: "Partial", rows: [["팀명", "비고"], ["영업1팀", "메모"]] }]);
  const rows = parseSheet(buf, "t.xlsx", [["팀명", "팀"], ["항목"]]);
  assert.equal(rows.length, 0);
  assert.deepEqual(rows._triedSheets, ["Partial"]);
  assert.equal(rows._headerRow, -1);
});

test("parseSheet() — excludedHeaders: 우연히 같은 헤더를 가진 무관한 시트를 배제한다(실제 원본 파일의 '예산' vs '조직별' 오인식 사고 재현)", () => {
  const buf = buildWorkbookBuffer([
    { name: "예산", rows: [["구분", "팀명", "항목", "1월"], ["판관", "인사팀", "통신비", 90000]] },
    { name: "조직별", rows: [["구분", "부문", "1월"], ["인원", "인사팀", 5]] },
  ]);
  const rows = parseSheet(buf, "t.xlsx", [["구분", "부문"], ["1월"]], ["팀명", "항목"]);
  assert.equal(rows._sheetName, "조직별");
  assert.equal(rows[0]["부문"], "인사팀");
});

test("parseSheet() — 시트 상단이 완전히 비어 !ref가 0행부터 시작하지 않아도 헤더행을 정확히 찾는다(절대행 보정)", () => {
  // origin 'A3' → 실제 데이터가 엑셀 3행(0-index 2)부터 시작, 위 2행은 워크시트에 아예 없음.
  const buf = buildWorkbookWithOffset("조직별", [
    ["구분", "부문", "1월"],
    ["인원", "인사팀", 5],
  ], "A3");
  const rows = parseSheet(buf, "t.xlsx", [["구분", "부문"], ["1월"]]);
  assert.equal(rows._headerRow, 2, "헤더가 엑셀 3행(0-index 2)에서 정확히 발견돼야 한다");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["부문"], "인사팀");
  assert.equal(rows[0]["1월"], 5);
});

test("parseSheet() — 헤더 탐색은 시트당 상위 20행까지만 스캔한다(그 밖에 있으면 못 찾음)", () => {
  const filler = Array.from({ length: 20 }, () => ["", "", ""]);
  const rows2D = [...filler, ["팀명", "항목", "1월"], ["영업1팀", "소모품비", 50000]];
  const buf = buildWorkbookBuffer([{ name: "S", rows: rows2D }]);
  const rows = parseSheet(buf, "t.xlsx", [["팀명", "팀"], ["항목"]]);
  assert.equal(rows.length, 0, "헤더가 21번째 줄(스캔 한도 밖)에 있으면 찾지 못해야 한다");
});

test("parseSheet() — 필요한 헤더를 가진 시트가 전혀 없으면 빈 배열 + 확인한 시트 목록을 반환한다", () => {
  const buf = buildWorkbookBuffer([
    { name: "Sheet1", rows: [["이름", "전화번호"], ["홍길동", "010-1234-5678"]] },
    { name: "Sheet2", rows: [["부서", "직급"], ["개발본부", "과장"]] },
  ]);
  const rows = parseSheet(buf, "t.xlsx", [["팀명", "팀"], ["항목"]]);
  assert.equal(rows.length, 0);
  assert.deepEqual(rows._triedSheets, ["Sheet1", "Sheet2"]);
  assert.equal(rows._sheetName, null);
  assert.equal(rows._headerRow, -1);
});
