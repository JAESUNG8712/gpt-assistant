// server.js를 JSON 파일 모드(DATABASE_URL 미설정)로 별도 프로세스에 띄워 검증하는
// API 스모크 테스트. 운영 DB·실제 데이터·실제 AI 키는 사용하지 않는다 — 이력서
// 파서의 AI 호출은 이 파일 안의 로컬 mock HTTP 서버로 대체한다(HR_RESUME_GROQ_URL_OVERRIDE).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startServer } = require("../support/start-server");

// ── 이력서 파서 AI 호출을 가로채는 로컬 mock 서버 ───────────────────────────────
// server.js 프로세스가 이 서버로 요청을 보내도록 HR_RESUME_GROQ_URL_OVERRIDE로
// 가리킨다. mode를 바꿔가며 provider 성공/실패/timeout 세 가지 응답을 재현한다.
function startGroqMock() {
  let mode = "success";
  const srv = http.createServer((req, res) => {
    if (mode === "hang") return; // 응답을 아예 보내지 않아 AbortController 타임아웃을 유도
    if (mode === "fail") {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "mock provider failure" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ name: "홍길동", edu: "대학교 졸업" }) } }],
    }));
  });
  return new Promise(resolve => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        setMode: m => { mode = m; },
        close: () => new Promise(r => srv.close(r)),
      });
    });
  });
}

// 유효한 최소 PDF(텍스트 레이어 포함) — pdf-parse가 OCR 없이 바로 텍스트를 추출할
// 수 있도록 실제 PDF 문법으로 직접 구성한다(외부 도구·라이브러리 불필요).
function buildMinimalTextPdf(lines) {
  let y = 700;
  const tj = lines.map(l => {
    const esc = String(l).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const cmd = `BT /F1 12 Tf 50 ${y} Td (${esc}) Tj ET`;
    y -= 16;
    return cmd;
  }).join("\n");
  const objs = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(tj)} >>\nstream\n${tj}\nendstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const o of objs) { offsets.push(Buffer.byteLength(pdf)); pdf += o; }
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// 짧은 DOCX(순수 JS, mammoth로 추출 — OCR 도구 설치 여부와 무관하게 항상 결정적)
// — "텍스트 추출은 성공했지만 내용이 너무 짧다"(422)를 OCR 유무와 상관없이
// 재현하기 위해 PDF 대신 이걸 쓴다. jszip은 xlsx의 전이 의존성으로 이미 설치돼 있다.
async function buildShortDocx(text) {
  const JSZip = require("jszip");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

function multipartBody(fileBuffer, filename, mimeType) {
  const boundary = "----testboundary" + Math.random().toString(16).slice(2);
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([pre, fileBuffer, post]), contentType: `multipart/form-data; boundary=${boundary}` };
}

test("file-mode API smoke suite", async (t) => {
  const groqMock = await startGroqMock();
  const server = await startServer({
    env: {
      HR_RESUME_GROQ_URL_OVERRIDE: groqMock.url,
      RESUME_AI_TIMEOUT_MS: "500",
    },
  });
  t.after(async () => { await server.stop(); await groqMock.close(); });

  const api = (p, opts) => fetch(server.baseUrl + p, opts);

  let adminToken;

  await t.test("1) 빈 저장소에 test admin/member를 bootstrap 저장", async () => {
    const res = await api("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        _version: 0,
        data: {
          employees: [
            { id: 1, loginId: "test_admin", pw: "test_admin_pw", role: "admin", name: "테스트관리자", empNo: "T1", dept: "", team: "", active: true },
            { id: 2, loginId: "test_member", pw: "test_member_pw", role: "member", name: "테스트팀원", empNo: "T2", dept: "", team: "", active: true },
          ],
          kpiEntries: [],
        },
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.meta.empCount, 2);
  });

  await t.test("2) GET /status가 file mode를 반환", async () => {
    const res = await api("/status");
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.storageMode, "file");
  });

  await t.test("3) 잘못된 로그인은 ok:false", async () => {
    const res = await api("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "test_admin", pw: "wrong-password" }),
    });
    const json = await res.json();
    assert.equal(json.ok, false);
  });

  await t.test("4) 정상 admin 로그인은 token 반환 + employee에 pw 없음", async () => {
    const res = await api("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "test_admin", pw: "test_admin_pw" }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(json.token && typeof json.token === "string");
    assert.equal(json.employee.pw, undefined);
    adminToken = json.token;
  });

  await t.test("5) 무토큰 GET /data는 401", async () => {
    const res = await api("/data");
    assert.equal(res.status, 401);
  });

  await t.test("6) 정상 Bearer GET /data는 200이며 타 직원 pw 해시가 없음", async () => {
    const res = await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    for (const emp of json.data.employees) assert.equal(emp.pw, undefined);
  });

  await t.test("7) 변조 token은 401", async () => {
    const tampered = adminToken.slice(0, -3) + (adminToken.slice(-3) === "AAA" ? "BBB" : "AAA");
    const res = await api("/data", { headers: { Authorization: `Bearer ${tampered}` } });
    assert.equal(res.status, 401);
  });

  await t.test("8) /save 후 version 증가 및 기존 collection 보존", async () => {
    const before = await (await api("/status")).json();
    const res = await api("/save?user=test_admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        _version: before.version,
        data: {
          employees: [
            { id: 1, loginId: "test_admin", pw: "test_admin_pw", role: "admin", name: "테스트관리자", empNo: "T1", dept: "", team: "", active: true },
            { id: 2, loginId: "test_member", pw: "test_member_pw", role: "member", name: "테스트팀원", empNo: "T2", dept: "", team: "", active: true },
            { id: 3, loginId: "test_member2", pw: "pw3", role: "member", name: "팀원3", empNo: "T3", dept: "", team: "", active: true },
          ],
          kpiEntries: [],
        },
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(json.version > before.version, `version should increase (${before.version} -> ${json.version})`);
    assert.equal(json.meta.empCount, 3, "기존 2명 + 신규 1명 = 3명 보존");
  });

  await t.test("9) NODE_ENV=production, ALLOW_DEMO_DATA=false에서 demo marker 신규 저장 403", async () => {
    // 이 검사는 프로세스 시작 시점의 NODE_ENV에 좌우되므로, 별도의 production 전용
    // 서버 인스턴스를 이 케이스만을 위해 새로 띄운다(공유 서버의 NODE_ENV를 바꿀 수 없음).
    const prodMock = await startGroqMock();
    const prodServer = await startServer({
      env: { NODE_ENV: "production", HR_RESUME_GROQ_URL_OVERRIDE: prodMock.url },
    });
    try {
      const papi = (p, opts) => fetch(prodServer.baseUrl + p, opts);
      const res = await papi("/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _version: 0,
          data: {
            employees: [{ id: 1, loginId: "admin", pw: "pw", role: "admin", name: "관리자", empNo: "DEMO-0001", dept: "", team: "", active: true, source: "demo" }],
            kpiEntries: [],
          },
        }),
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.equal(json.code, "DEMO_DATA_FORBIDDEN");
      const status = await (await papi("/status")).json();
      assert.equal(status.meta.empCount, 0, "거부된 저장은 실제로 반영되지 않아야 함");
    } finally {
      await prodServer.stop();
      await prodMock.close();
    }
  });

  await t.test("10) resume parser 오류코드 매핑 — 401/403/400×3/413/422/503/502/504", async () => {
    const pdf = buildMinimalTextPdf(["Hong Gildong", "Email: hong@example.com", "Phone: 010-1111-2222"]);
    const { body, contentType } = multipartBody(pdf, "resume.pdf", "application/pdf");

    // 401: 무토큰
    {
      const res = await api("/api/hr/resume-parse", { method: "POST", headers: { "Content-Type": contentType }, body });
      assert.equal(res.status, 401);
    }
    // 403: member 토큰
    {
      const loginRes = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: "test_member", pw: "test_member_pw" }) })).json();
      const res = await api("/api/hr/resume-parse", { method: "POST", headers: { "Content-Type": contentType, Authorization: `Bearer ${loginRes.token}` }, body });
      assert.equal(res.status, 403);
    }
    // 400: 파일 없음
    {
      const res = await api("/api/hr/resume-parse", { method: "POST", headers: { Authorization: `Bearer ${adminToken}` } });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "RESUME_FILE_REQUIRED");
    }
    // 400: 지원하지 않는 확장자
    {
      const { body: txtBody, contentType: txtCt } = multipartBody(Buffer.from("plain text"), "note.txt", "text/plain");
      const res = await api("/api/hr/resume-parse", { method: "POST", headers: { "Content-Type": txtCt, Authorization: `Bearer ${adminToken}` }, body: txtBody });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "RESUME_TYPE_UNSUPPORTED");
    }
    // 400: 확장자 위장(PNG 바이트를 .pdf로)
    {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      const { body: spoofBody, contentType: spoofCt } = multipartBody(png, "fake.pdf", "application/pdf");
      const res = await api("/api/hr/resume-parse", { method: "POST", headers: { "Content-Type": spoofCt, Authorization: `Bearer ${adminToken}` }, body: spoofBody });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "RESUME_FILE_INVALID");
    }
    // 413: 15MB 초과
    {
      const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(16 * 1024 * 1024, 0x41)]);
      const { body: bigBody, contentType: bigCt } = multipartBody(big, "big.pdf", "application/pdf");
      const res = await api("/api/hr/resume-parse", { method: "POST", headers: { "Content-Type": bigCt, Authorization: `Bearer ${adminToken}` }, body: bigBody });
      assert.equal(res.status, 413);
      assert.equal((await res.json()).code, "RESUME_FILE_TOO_LARGE");
    }
    // 422: 텍스트 추출은 성공했지만 내용이 20자 미만(DOCX는 mammoth로 순수 JS
    // 추출이라 OCR 도구 설치 여부와 무관하게 항상 결정적으로 재현된다 — PDF로
    // 이 경우를 재현하면 텍스트 레이어가 짧을 때 OCR 폴백을 먼저 타서, OCR 도구가
    // 없는 환경(이 CI 포함)에서는 아래의 503과 뒤섞여 버린다).
    {
      const tinyDocx = await buildShortDocx("hi");
      const { body: tinyBody, contentType: tinyCt } = multipartBody(tinyDocx, "tiny.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      const res = await api("/api/hr/resume-parse", { method: "POST", headers: { "Content-Type": tinyCt, Authorization: `Bearer ${adminToken}` }, body: tinyBody });
      assert.equal(res.status, 422);
      assert.equal((await res.json()).code, "RESUME_TEXT_UNREADABLE");
    }
    // 503 RESUME_OCR_UNAVAILABLE: 텍스트 레이어가 너무 짧아 OCR로 폴백해야 하는
    // PDF인데, 이 테스트 환경에는 poppler-utils/tesseract-ocr이 설치돼 있지 않다
    // (설치돼 있었다면 이 서브케이스는 스킵 — 아래에서 실제로 확인).
    {
      const { execSync } = require("node:child_process");
      let ocrInstalled = true;
      try { execSync("which pdftoppm tesseract", { stdio: "ignore" }); } catch (e) { ocrInstalled = false; }
      if (!ocrInstalled) {
        const tinyPdf = buildMinimalTextPdf(["hi"]);
        const { body: tinyBody, contentType: tinyCt } = multipartBody(tinyPdf, "tiny.pdf", "application/pdf");
        const res = await api("/api/hr/resume-parse", { method: "POST", headers: { "Content-Type": tinyCt, Authorization: `Bearer ${adminToken}` }, body: tinyBody });
        assert.equal(res.status, 503);
        assert.equal((await res.json()).code, "RESUME_OCR_UNAVAILABLE");
      }
    }
    // 503: GROQ_API_KEY 없이 호출 — 이 프로세스는 GROQ_API_KEY를 설정하지 않았으므로 기본값으로 503
    {
      const res = await api("/api/hr/resume-parse", { method: "POST", headers: { "Content-Type": contentType, Authorization: `Bearer ${adminToken}` }, body });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, "RESUME_AI_UNAVAILABLE");
    }
    assert.equal(server.child.exitCode, null, "이 시점까지 서버 프로세스가 죽지 않아야 함");
  });
});

// GROQ_API_KEY가 있는 상태에서의 provider 성공/실패/timeout 경로는 키 설정 여부
// 자체가 프로세스 시작 시점에 고정되므로 별도 서버 인스턴스로 검증한다.
test("resume parser: provider mock 502/504/성공 경로", async (t) => {
  const groqMock = await startGroqMock();
  const server = await startServer({
    env: {
      HR_RESUME_GROQ_URL_OVERRIDE: groqMock.url,
      RESUME_AI_TIMEOUT_MS: "500",
      GROQ_API_KEY: "test-fake-key-not-a-real-secret",
    },
  });
  t.after(async () => { await server.stop(); await groqMock.close(); });
  const api = (p, opts) => fetch(server.baseUrl + p, opts);

  await api("/save", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ _version: 0, data: { employees: [{ id: 1, loginId: "a", pw: "p", role: "admin", name: "A", empNo: "A1", dept: "", team: "", active: true }], kpiEntries: [] } }),
  });
  const loginRes = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: "a", pw: "p" }) })).json();
  const token = loginRes.token;
  const pdf = buildMinimalTextPdf(["Hong Gildong", "Email: hong@example.com", "Phone: 010-1111-2222"]);
  const { body, contentType } = multipartBody(pdf, "resume.pdf", "application/pdf");
  const headers = { "Content-Type": contentType, Authorization: `Bearer ${token}` };

  await t.test("502 RESUME_AI_FAILED — provider가 500을 반환", async () => {
    groqMock.setMode("fail");
    const res = await api("/api/hr/resume-parse", { method: "POST", headers, body });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, "RESUME_AI_FAILED");
  });

  await t.test("504 RESUME_AI_TIMEOUT — provider가 응답하지 않음", async () => {
    groqMock.setMode("hang");
    const res = await api("/api/hr/resume-parse", { method: "POST", headers, body });
    assert.equal(res.status, 504);
    assert.equal((await res.json()).code, "RESUME_AI_TIMEOUT");
  });

  await t.test("200 성공 — provider가 정상 응답, 원문 텍스트/키가 응답에 없음", async () => {
    groqMock.setMode("success");
    const res = await api("/api/hr/resume-parse", { method: "POST", headers, body });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.fields.name, "홍길동");
    const raw = JSON.stringify(json);
    assert.ok(!raw.includes("api.groq.com"), "응답에 provider 엔드포인트가 노출되면 안 됨");
    assert.ok(!raw.includes("test-fake-key-not-a-real-secret"), "응답에 API 키가 노출되면 안 됨");
    assert.ok(!raw.includes("Hong Gildong"), "응답에 원문 이력서 텍스트가 그대로 노출되면 안 됨");
  });
});
