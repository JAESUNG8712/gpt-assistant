// budget.js에서 분리(2026-08-24) — 예산/사업계획 엑셀 업로드 5개 라우트가 전부 거쳐가는
// 핵심 파싱 로직. xlsx@0.18.5는 npm audit에 걸린 취약점(prototype pollution + ReDoS)이
// 있어(패치판은 npm 레지스트리에 없고 SheetJS 자사 CDN에만 있어 이 환경에선 설치·검증이
// 불가능한 상태 — 사용자에게 별도 안내) 언젠가 버전을 올려야 하는데, 이 함수만 별도
// 모듈로 분리해두면 ① 워커 스레드(lib/parse-sheet-worker.js, budget.js의
// parseSheetIsolated 참고 — ReDoS가 걸려도 메인 서버 이벤트 루프가 멈추지 않도록 격리)와
// budget.js 양쪽이 동일한 로직을 공유하고, ② test/api-parse-sheet.test.js가 HTTP 요청·
// 워커 스레드 없이 이 순수 함수를 직접 호출해 빠르게 회귀 검증할 수 있다.
"use strict";
const xlsx = require("xlsx");

// requiredHeaderGroups를 지정하면(예: [['팀명','팀'],['항목']]) 단순히 "첫 시트의 1행"만
// 헤더로 보는 대신, 워크북의 모든 시트·앞부분 행(최대 20행)을 훑어 그룹마다 하나 이상의
// 헤더 텍스트를 포함하는 행을 찾아 그 행을 헤더로 삼아 파싱한다 — 실제 회사 원본 엑셀처럼
// 여러 시트가 한 파일에 섞여 있고(예: "RAW자료"/"예산"/"조직별") 실제 데이터 시트의 헤더가
// 제목행 등으로 인해 1행이 아닌 경우(예: 2행)에도 올바른 시트·행을 자동으로 찾아낸다.
// 못 찾으면 빈 배열을 반환하되 어떤 시트들을 확인했는지 `_triedSheets`에 남겨 진단에 쓴다.
// requiredHeaderGroups를 생략하면(레거시 호출부) 기존과 동일하게 첫 시트·1행을 그대로 쓴다.
// excludedHeaders — 실제 회사 원본 파일에서 "예산"(비인건비) 시트가 "구분"·"1월" 컬럼을
// 모두 갖고 있어("판관/용역/경상" 분류용 "구분" 컬럼이 우연히 이름이 같음), 워크북 순서상
// "예산" 시트가 "조직별"(인원계획) 시트보다 먼저 나오면 인원계획 업로드가 엉뚱하게 예산
// 시트를 파싱하는 사고가 실제로 재현됨(사용자 첨부 원본 파일로 확인) — 이 목록에 있는
// 헤더가 하나라도 있는 행은 후보에서 제외해 "예산" 시트를 걸러낸다.
function parseSheet(buffer, filename, requiredHeaderGroups, excludedHeaders) {
  const isCsv = /\.csv$/i.test(filename || '');
  const workbook = isCsv
    ? xlsx.read(buffer.toString('utf8'), { type: 'string' })
    : xlsx.read(buffer, { type: 'buffer' });
  if (Array.isArray(requiredHeaderGroups) && requiredHeaderGroups.length) {
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      // header:1 모드는 기본적으로 시트의 !ref 범위를 대상으로 하고, 반환 배열의 인덱스는
      // 그 범위의 시작행 기준 "상대" 위치다. 맨 위 몇 행이 완전히 비어 있는 시트는 !ref가
      // 0행이 아닌 곳부터 시작하는데(예: 사용자 원본 파일의 "조직별" 시트는 !ref가 "A2:V91"
      // — 실제 첫 행이 엑셀 2행), 그 상대 인덱스를 그대로 아래 range 옵션(절대 행 번호를
      // 기대함)에 넘기면 엉뚱한 행(제목행 등)을 헤더로 잘못 잡는 오차가 생긴다(실제 파일로
      // 재현·발견 — 이 어긋남 때문에 "조직별" 업로드가 바로 위의 "예산" 시트 헤더 행을
      // 잘못 읽어들이고 있었음). !ref의 시작행을 더해 절대 행 번호로 보정한다.
      const refStartRow = sheet['!ref'] ? xlsx.utils.decode_range(sheet['!ref']).s.r : 0;
      const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
      for (let i = 0; i < Math.min(raw.length, 20); i++) {
        const rowVals = (raw[i] || []).map(v => String(v).trim());
        if (Array.isArray(excludedHeaders) && excludedHeaders.some(h => rowVals.includes(h))) continue;
        if (requiredHeaderGroups.every(group => group.some(h => rowVals.includes(h)))) {
          const absoluteRow = refStartRow + i;
          const rows = xlsx.utils.sheet_to_json(sheet, { range: absoluteRow, defval: null, raw: true });
          rows._sheetName = sheetName;
          rows._headerRow = absoluteRow;
          return rows;
        }
      }
    }
    const empty = [];
    empty._sheetName = null;
    empty._headerRow = -1;
    empty._triedSheets = workbook.SheetNames;
    return empty;
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return xlsx.utils.sheet_to_json(sheet, { defval: null, raw: true });
}

module.exports = { parseSheet };
