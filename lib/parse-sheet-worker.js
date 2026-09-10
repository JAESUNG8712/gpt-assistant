// budget.js의 parseSheetIsolated()가 띄우는 워커 스레드 진입점. SheetJS는 패치된
// 0.20.3을 사용하지만, 손상되거나 비정상적으로 복잡한 파일의 파싱이 CPU를 오래 점유할 수
// 있다 — 이 서버는 여러
// 회사가 같은 Node 프로세스(단일 이벤트 루프)를 공유하는 멀티테넌트 구조라, 메인 스레드에서
// 그대로 실행하면 한 회사의 업로드 하나가 다른 모든 회사·모든 사용자의 요청을 함께 멈춰
// 세운다. 파싱을 별도 워커 스레드로 격리해, 설령 이 취약점이 실제로 트리거돼도 메인
// 이벤트 루프는 계속 정상 동작하고(다른 요청은 영향 없음) parseSheetIsolated()의 타임아웃이
// 그 워커만 강제 종료해 피해 범위를 "업로드 한 건"으로 가둔다.
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
