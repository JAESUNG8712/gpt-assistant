// public/index.html은 단일 파일 SPA라 브라우저 없이는 정상적인 lint/typecheck가
// 없다. 이 스크립트는 그 파일의 <script> 태그 안 인라인 JS만 뽑아 순수 문법
// 검사(vm.Script — 파싱만 하고 절대 실행하지 않음)를 한다. DOM/document/window 등이
// 없는 환경이라 코드를 실제로 돌리면 대부분 즉시 예외가 나므로, 여기서는 "JS로서
// 문법이 유효한가"만 확인한다 — 함수 안에서 쓰는 미정의 변수·오타 등 런타임 오류는
// 잡지 못한다(Playwright e2e가 그 역할을 한다).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const TARGET = path.join(__dirname, "..", "public", "index.html");

function extractInlineScripts(html) {
  // src= 속성이 있는 <script>(외부 파일)는 제외 — 이 파일은 그런 태그를 쓰지 않지만
  // 혹시 추가되더라도 여기서 잘못 잡아 "문법 오류"로 오탐하지 않도록 방어.
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  const scripts = [];
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const body = m[2];
    if (body && body.trim()) scripts.push({ index: scripts.length, offset: m.index, body });
  }
  return scripts;
}

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`[check-client-syntax] 대상 파일을 찾을 수 없습니다: ${TARGET}`);
    process.exit(1);
  }
  const html = fs.readFileSync(TARGET, "utf8");
  const scripts = extractInlineScripts(html);
  if (!scripts.length) {
    console.error("[check-client-syntax] 인라인 <script> 태그를 찾지 못했습니다 — 파일 구조가 바뀌었는지 확인하세요.");
    process.exit(1);
  }

  let failed = 0;
  for (const s of scripts) {
    try {
      // filename을 주면 문법 오류 스택에 정확한 위치(대략적인 줄 번호)가 찍힌다.
      new vm.Script(s.body, { filename: `public/index.html#inline-script-${s.index}` });
    } catch (e) {
      failed++;
      console.error(`[check-client-syntax] 문법 오류 (script #${s.index}): ${e.message}`);
    }
  }

  if (failed) {
    console.error(`[check-client-syntax] 실패: ${failed}/${scripts.length}개 인라인 스크립트에서 문법 오류.`);
    process.exit(1);
  }
  console.log(`[check-client-syntax] 통과: 인라인 스크립트 ${scripts.length}개 전부 문법 유효.`);
}

main();
