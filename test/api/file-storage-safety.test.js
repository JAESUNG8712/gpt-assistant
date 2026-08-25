"use strict";

// JSON 파일 모드에서 손상된 기존 파일을 빈 저장소로 취급해 덮어쓰지 않고, 다중
// worker 구성을 명시적으로 거부하는지 검증한다. 모든 파일은 start-server 헬퍼가 만든
// os.tmpdir() 아래의 테스트 전용 디렉터리에만 작성된다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { startServerExpectingBootFailure } = require("../support/start-server");

test("file storage safety: 손상된 기존 JSON 파일은 데이터 보존 상태로 fail-fast한다", async (t) => {
  await t.test("메인 DATA_FILE 손상", async () => {
    const corrupt = '{"employees": [';
    const result = await startServerExpectingBootFailure({ seedRaw: corrupt });
    try {
      assert.notEqual(result.exitCode, 0);
      assert.match(result.logs.stderr + result.logs.stdout, /메인 데이터 파일을 읽거나 해석할 수 없어/);
      assert.equal(fs.readFileSync(result.dataFile, "utf8"), corrupt, "실패한 부팅은 손상 원본을 바꾸면 안 됨");
    } finally {
      result.cleanup();
    }
  });

  await t.test("회계 위성 파일 손상", async () => {
    const corrupt = '{"accounts": [';
    const result = await startServerExpectingBootFailure({
      seedFiles: { "hr-data-accounting.json": corrupt },
    });
    const acctFile = result.dataFile.replace(/\.json$/, "-accounting.json");
    try {
      assert.notEqual(result.exitCode, 0);
      assert.match(result.logs.stderr + result.logs.stdout, /회계 데이터 파일을 읽거나 해석할 수 없어/);
      assert.equal(fs.readFileSync(acctFile, "utf8"), corrupt, "위성 파일도 실패한 부팅이 바꾸면 안 됨");
    } finally {
      result.cleanup();
    }
  });
});

test("file storage safety: JSON 파일 모드는 다중 worker 구성을 fail-fast한다", async () => {
  const result = await startServerExpectingBootFailure({ env: { WEB_CONCURRENCY: "2" } });
  try {
    assert.notEqual(result.exitCode, 0);
    assert.match(result.logs.stderr + result.logs.stdout, /WEB_CONCURRENCY=1만 지원/);
  } finally {
    result.cleanup();
  }
});
