// budget.js의 parseSheetIsolated()가 띄우는 워커 스레드 진입점. xlsx@0.18.5의 알려진
// ReDoS 취약점(GHSA-5pgg-2g8v-p4x9)이 트리거되면 xlsx.read()/sheet_to_json() 호출 하나가
// 정규식 catastrophic backtracking에 빠져 무한정 CPU를 잡아먹을 수 있다 — 이 서버는 여러
// 회사가 같은 Node 프로세스(단일 이벤트 루프)를 공유하는 멀티테넌트 구조라, 메인 스레드에서
// 그대로 실행하면 한 회사의 업로드 하나가 다른 모든 회사·모든 사용자의 요청을 함께 멈춰
// 세운다. 파싱을 별도 워커 스레드로 격리해, 설령 이 취약점이 실제로 트리거돼도 메인
// 이벤트 루프는 계속 정상 동작하고(다른 요청은 영향 없음) parseSheetIsolated()의 타임아웃이
// 그 워커만 강제 종료한다 — 근본 수정(패키지 버전 교체)을 대신하는 것이 아니라, 그 전까지
// 피해 범위를 "업로드 한 건"으로 가두는 완화책이다.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const { parseSheet } = require("./parse-sheet");

try {
  const { buffer, filename, requiredHeaderGroups, excludedHeaders } = workerData;
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const rows = parseSheet(raw, filename, requiredHeaderGroups, excludedHeaders);
  parentPort.postMessage({
    ok: true,
    rows,
    meta: { sheetName: rows._sheetName, headerRow: rows._headerRow, triedSheets: rows._triedSheets },
  });
} catch (e) {
  parentPort.postMessage({ ok: false, message: (e && e.message) || String(e) });
}
