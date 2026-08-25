// server.js를 JSON 파일 모드(DATABASE_URL 미설정)로 별도 프로세스에 띄워 검증하는
// API 스모크 테스트. 운영 DB·실제 데이터·실제 AI 키는 사용하지 않는다 — 이력서
// 파서의 AI 호출은 이 파일 안의 로컬 mock HTTP 서버로 대체한다(HR_RESUME_GROQ_URL_OVERRIDE).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startServer, bootstrapAdminAndLogin } = require("../support/start-server");

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
  let adminId;

  await t.test("1) 빈 저장소는 익명 /save를 거부하고 one-time bootstrap 후 관리자만 저장", async () => {
    const anonymous = await api("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _version: 0, data: { employees: [], kpiEntries: [] } }),
    });
    assert.equal(anonymous.status, 401);

    const boot = await bootstrapAdminAndLogin(server, {
      loginId: "test_admin", pw: "test_admin_pw", name: "테스트관리자",
    });
    adminId = boot.employee.id;
    const res = await api("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${boot.token}` },
      body: JSON.stringify({
        _version: 0,
        data: {
          employees: [
            { id: boot.employee.id, loginId: "test_admin", pw: "test_admin_pw", role: "admin", name: "테스트관리자", empNo: "T1", dept: "", team: "", active: true, salary: 90000000, birth: "1980-01-01", address: "비공개 주소", phone: "010-9999-9999" },
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

  await t.test("7b) 일반 사용자는 타 직원 PII·전사 설정을 바꾸거나 자신의 권한/비밀번호를 높일 수 없다", async () => {
    const adminBefore = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const storedBefore = adminBefore.data.employees.find(e => String(e.id) === String(adminId));
    const memberLogin = await (await api("/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "test_member", pw: "test_member_pw" }),
    })).json();
    assert.equal(memberLogin.ok, true);
    const memberRead = await api("/data", { headers: { Authorization: `Bearer ${memberLogin.token}` } });
    assert.equal(memberRead.status, 200);
    const memberState = await memberRead.json();
    const other = memberState.data.employees.find(e => String(e.id) === String(adminId));
    assert.equal(other.salary, undefined);
    assert.equal(other.birth, undefined);
    assert.equal(other.address, undefined);
    // email/phone은 사내 연락처 검색에 필요한 공개 directory 필드다. 급여·생년월일·주소와
    // 달리 민감정보 축소 대상이 아니며, 서버 저장값 그대로만 노출돼야 한다.
    assert.equal(other.phone, storedBefore.phone);

    const me = memberState.data.employees.find(e => e.loginId === "test_member");
    me.role = "admin";
    me.pw = "member_new_password";
    me.updatedAt = "2099-01-01T00:00:00.000Z";
    const attack = await api("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberLogin.token}` },
      body: JSON.stringify({ _version: memberState.version, data: { ...memberState.data, settings: { companyName: "forbidden" } } }),
    });
    assert.equal(attack.status, 200);

    const oldLogin = await (await api("/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "test_member", pw: "test_member_pw" }),
    })).json();
    assert.equal(oldLogin.ok, true, "기존 비밀번호는 유지되어야 한다");
    assert.equal(oldLogin.employee.role, "member");
    const newLogin = await (await api("/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "test_member", pw: "member_new_password" }),
    })).json();
    assert.equal(newLogin.ok, false, "클라이언트가 보낸 새 비밀번호는 저장되면 안 된다");

    const adminRead = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const storedAdmin = adminRead.data.employees.find(e => e.loginId === "test_admin");
    assert.equal(storedAdmin.salary, storedBefore.salary);
    assert.equal(storedAdmin.address, storedBefore.address);
    assert.equal(storedAdmin.phone, storedBefore.phone);
    assert.notEqual(adminRead.data.settings?.companyName, "forbidden");
  });

  await t.test("7c) KPI 메뉴가 모두 꺼진 계정은 AI 목표 초안 API를 직접 호출해도 403", async () => {
    const state = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const me = state.data.employees.find(e => String(e.id) === String(adminId));
    me.menuPerms = { ...(me.menuPerms || {}), kpi: false, "kpi-results": false };
    const saved = await api("/save", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ _version: state.version, data: state.data }),
    });
    assert.equal(saved.status, 200);
    const denied = await api("/api/hr/draft-kpi-goal", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ jobRole: "개발자" }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, "MENU_ACCESS_DENIED");

    const latest = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const latestMe = latest.data.employees.find(e => String(e.id) === String(adminId));
    latestMe.menuPerms = { ...(latestMe.menuPerms || {}), kpi: true, "kpi-results": true };
    assert.equal((await api("/save", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ _version: latest.version, data: latest.data }),
    })).status, 200);
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
            { id: adminId, loginId: "test_admin", pw: "test_admin_pw", role: "admin", name: "테스트관리자", empNo: "T1", dept: "", team: "", active: true },
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
      const boot = await bootstrapAdminAndLogin(prodServer, {
        loginId: "prod_admin", pw: "prod_admin_pw", name: "운영테스트관리자",
      });
      const res = await papi("/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${boot.token}` },
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
      assert.equal(status.meta.empCount, 1, "거부된 저장은 bootstrap 관리자 외에 반영되면 안 됨");
    } finally {
      await prodServer.stop();
      await prodMock.close();
    }
  });

  await t.test("9b) 채용 legacy 이력서 추출도 형식·크기·호출량 제한을 적용하면서 기존 PDF 계약을 유지", async () => {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` };
    const pdf = buildMinimalTextPdf(["Hong Gildong", "Email: hong@example.com", "Phone: 010-1111-2222"]);
    const valid = await api("/api/recruit/extract-pdf-text", {
      method: "POST", headers,
      body: JSON.stringify({ dataUrl: `data:application/pdf;base64,${pdf.toString("base64")}` }),
    });
    assert.equal(valid.status, 200);
    const validJson = await valid.json();
    assert.equal(validJson.ok, true);
    assert.match(validJson.text, /Hong Gildong/);

    const spoof = await api("/api/recruit/extract-pdf-text", {
      method: "POST", headers,
      body: JSON.stringify({ dataUrl: `data:application/pdf;base64,${Buffer.from("not a pdf").toString("base64")}` }),
    });
    assert.equal(spoof.status, 400);
    assert.equal((await spoof.json()).code, "RESUME_FILE_INVALID");

    const oversizedBase64 = "A".repeat(Math.ceil((15 * 1024 * 1024) / 3) * 4 + 8);
    const oversized = await api("/api/recruit/extract-pdf-text", {
      method: "POST", headers,
      body: JSON.stringify({ dataUrl: `data:application/pdf;base64,${oversizedBase64}` }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).code, "RESUME_FILE_TOO_LARGE");

    // 위 3건을 포함해 같은 계정의 10건까지 처리되고, 11번째부터 실제 추출 전에 차단된다.
    for (let i = 0; i < 7; i++) {
      const attempt = await api("/api/recruit/extract-pdf-text", {
        method: "POST", headers,
        body: JSON.stringify({ dataUrl: "data:application/pdf;base64,bm90IGEgcGRm" }),
      });
      assert.equal(attempt.status, 400);
    }
    const limited = await api("/api/recruit/extract-pdf-text", {
      method: "POST", headers,
      body: JSON.stringify({ dataUrl: "data:application/pdf;base64,bm90IGEgcGRm" }),
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, "RESUME_RATE_LIMITED");
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

  await t.test("10b) 동일 직원의 동시 복지포인트 사용은 잔액을 초과하지 않는다", async () => {
    const adminState = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const member = adminState.data.employees.find(e => e.loginId === "test_member");
    const year = 2097;
    const grant = { id: "wp-concurrency-grant", empId: member.id, points: 100000, type: "grant", year, desc: "동시성 검증 부여", date: "2097-01-01", by: adminId };
    const grantSave = await api("/save", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ _version: adminState.version, data: { ...adminState.data, welfarePoints: [...(adminState.data.welfarePoints || []), grant] } }),
    });
    assert.equal(grantSave.status, 200);

    const memberLogin = await (await api("/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "test_member", pw: "test_member_pw" }),
    })).json();
    assert.equal(memberLogin.ok, true);
    const [stateA, stateB] = await Promise.all([
      api("/data", { headers: { Authorization: `Bearer ${memberLogin.token}` } }).then(r => r.json()),
      api("/data", { headers: { Authorization: `Bearer ${memberLogin.token}` } }).then(r => r.json()),
    ]);
    const makePayload = (state, id) => ({
      _version: state.version,
      data: { ...state.data, welfarePoints: [...(state.data.welfarePoints || []), { id, empId: member.id, points: 70000, type: "use", year, desc: "동시 사용", date: "2097-02-01", by: member.id }] },
    });
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${memberLogin.token}` };
    const [useA, useB] = await Promise.all([
      api("/save", { method: "POST", headers, body: JSON.stringify(makePayload(stateA, "wp-concurrent-use-a")) }),
      api("/save", { method: "POST", headers, body: JSON.stringify(makePayload(stateB, "wp-concurrent-use-b")) }),
    ]);
    assert.equal(useA.status, 200);
    assert.equal(useB.status, 200);
    const finalState = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const ledger = (finalState.data.welfarePoints || []).filter(r => String(r.empId) === String(member.id) && r.year === year);
    const granted = ledger.filter(r => r.type === "grant").reduce((sum, r) => sum + r.points, 0);
    const used = ledger.filter(r => r.type === "use").reduce((sum, r) => sum + r.points, 0);
    assert.equal(granted, 100000);
    assert.equal(used, 70000, "70,000원 동시 사용 2건 중 한 건만 반영돼야 함");
    assert.ok(granted - used >= 0, "복지포인트 잔액은 음수가 되면 안 됨");
  });

  await t.test("11) 계정 비활성화 뒤 기존 Bearer 토큰은 즉시 철회된다", async () => {
    const memberLogin = await (await api("/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "test_member", pw: "test_member_pw" }),
    })).json();
    assert.equal(memberLogin.ok, true);
    const adminState = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const member = adminState.data.employees.find(e => e.loginId === "test_member");
    member.active = false;
    member.updatedAt = "2099-01-02T00:00:00.000Z";
    const save = await api("/save", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ _version: adminState.version, data: adminState.data }),
    });
    assert.equal(save.status, 200);
    const oldToken = await api("/data", { headers: { Authorization: `Bearer ${memberLogin.token}` } });
    assert.equal(oldToken.status, 401);
  });

  await t.test("12) 동일 Idempotency-Key의 /save는 성공 응답을 재사용하고 다른 본문은 거부한다", async () => {
    const before = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const key = "test-idempotency-save-0001";
    const payload = { _version: before.version, _singletonRevisions: { settings: before.data._singletonRevisions?.settings || 0 }, _changedSingletonKeys: ["settings"], data: { settings: { ...(before.data.settings || {}), idempotencyProbe: "once" } } };
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}`, "Idempotency-Key": key };
    const first = await api("/save", { method: "POST", headers, body: JSON.stringify(payload) });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const replay = await api("/save", { method: "POST", headers, body: JSON.stringify(payload) });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("x-idempotency-replayed"), "true");
    assert.deepEqual(await replay.json(), firstBody);
    const reused = await api("/save", { method: "POST", headers, body: JSON.stringify({ ...payload, data: { settings: { idempotencyProbe: "changed" } } }) });
    assert.equal(reused.status, 409);
    assert.equal((await reused.json()).code, "IDEMPOTENCY_KEY_REUSED");
  });

  await t.test("13) 오래된 singleton revision 저장은 409로 차단하고 최신 설정을 보존한다", async () => {
    const base = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const revisions = { ...(base.data._singletonRevisions || {}), settings: base.data._singletonRevisions?.settings || 0 };
    const headersA = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}`, "Idempotency-Key": "singleton-revision-writer-a" };
    const headersB = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}`, "Idempotency-Key": "singleton-revision-writer-b" };
    const a = await api("/save", { method: "POST", headers: headersA, body: JSON.stringify({ _version: base.version, _singletonRevisions: revisions, _changedSingletonKeys: ["settings"], data: { settings: { ...(base.data.settings || {}), revisionProbe: "A" } } }) });
    assert.equal(a.status, 200);
    const b = await api("/save", { method: "POST", headers: headersB, body: JSON.stringify({ _version: base.version, _singletonRevisions: revisions, _changedSingletonKeys: ["settings"], data: { settings: { ...(base.data.settings || {}), revisionProbe: "B" } } }) });
    assert.equal(b.status, 409);
    const conflict = await b.json();
    assert.equal(conflict.code, "SINGLETON_REVISION_CONFLICT");
    assert.equal(conflict.details.key, "settings");
    const latest = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    assert.equal(latest.data.settings.revisionProbe, "A");
    assert.ok(latest.data._singletonRevisions.settings > (revisions.settings || 0));
  });

  await t.test("14) singleton을 수정하지 않은 stale 전체상태 저장은 최신 설정을 덮어쓰지 않는다", async () => {
    const latest = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const staleSettings = { ...(latest.data.settings || {}), revisionProbe: "STALE" };
    const res = await api("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}`, "Idempotency-Key": "unrelated-save-keeps-settings" },
      body: JSON.stringify({ _version: latest.version, _singletonRevisions: latest.data._singletonRevisions, _changedSingletonKeys: [], data: { settings: staleSettings, boardPosts: [] } }),
    });
    assert.equal(res.status, 200);
    const after = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    assert.equal(after.data.settings.revisionProbe, "A");

    const missingRevision = await api("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}`, "Idempotency-Key": "missing-singleton-revision" },
      body: JSON.stringify({ _version: after.version, _changedSingletonKeys: ["settings"], data: { settings: { revisionProbe: "BYPASS" } } }),
    });
    assert.equal(missingRevision.status, 428);
    assert.equal((await missingRevision.json()).code, "SINGLETON_REVISION_REQUIRED");
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
      AI_API_RATE_MAX: "3",
      GROQ_API_KEY: "test-fake-key-not-a-real-secret",
    },
  });
  t.after(async () => { await server.stop(); await groqMock.close(); });
  const api = (p, opts) => fetch(server.baseUrl + p, opts);

  const loginRes = await bootstrapAdminAndLogin(server, {
    loginId: "resume_admin", pw: "resume_admin_pw", name: "A",
  });

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

  await t.test("공통 AI quota는 같은 회사·계정의 서로 다른 AI API에도 합산 적용", async () => {
    const res = await api("/api/hr/draft-kpi-goal", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jobRole: "개발자", itemName: "품질 개선" }),
    });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).code, "AI_RATE_LIMITED");
  });
});
