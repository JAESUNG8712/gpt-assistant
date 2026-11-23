// 급여 명세서 PDF 생성 (pdfkit + 번들 한글 폰트).
// 금액은 서버가 계산한 slip(public/payslip-calc.js 결과 또는 저장된 명세서)을 그대로 그린다.
const path = require("path");
const PDFDocument = require("pdfkit");

const FONT_PATH = path.join(__dirname, "..", "assets", "fonts", "NotoSansKR-Regular.ttf");

function money(v) {
  const n = Math.round(Number(v) || 0);
  return (n < 0 ? "-" : "") + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "원";
}

// 한 줄(라벨 · 금액)을 그린다. 페이지 하단에 닿으면 새 페이지를 연다.
function row(doc, state, label, amount, opts = {}) {
  const { left, width } = state;
  if (state.y > doc.page.height - doc.page.margins.bottom - 40) {
    doc.addPage();
    state.y = doc.page.margins.top;
  }
  const bold = !!opts.bold;
  doc.font("Korean").fontSize(opts.size || 10).fillColor(opts.color || "#1e293b");
  doc.text(label, left + 8, state.y, { width: width * 0.65, lineBreak: false, ellipsis: true });
  doc.text(money(amount), left + width * 0.35, state.y, { width: width * 0.65 - 8, align: "right", lineBreak: false });
  state.y += (opts.size || 10) + 9;
  if (bold) {
    doc.moveTo(left, state.y - 4).lineTo(left + width, state.y - 4).strokeColor("#cbd5e1").lineWidth(0.5).stroke();
  }
}

function section(doc, state, title) {
  if (state.y > doc.page.height - doc.page.margins.bottom - 60) {
    doc.addPage();
    state.y = doc.page.margins.top;
  }
  doc.font("Korean").fontSize(11).fillColor("#0f766e").text(title, state.left, state.y, { lineBreak: false });
  state.y += 18;
}

// slip: 명세서 객체, emp: 직원, companyName: 회사명. 결과는 PDF 버퍼.
function renderPayslipPdf({ slip, emp, companyName }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: "급여 명세서", Author: companyName || "" } });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.registerFont("Korean", FONT_PATH);
    doc.font("Korean");

    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const state = { left, width, y: doc.page.margins.top };

    doc.fontSize(18).fillColor("#0f172a").text("급여 명세서", left, state.y, { width, align: "center", lineBreak: false });
    state.y += 30;
    doc.fontSize(10).fillColor("#475569").text(`${companyName || ""}`, left, state.y, { width, align: "center", lineBreak: false });
    state.y += 16;
    doc.fontSize(10).fillColor("#475569").text(`${slip.year}년 ${slip.month}월 귀속`, left, state.y, { width, align: "center", lineBreak: false });
    state.y += 26;

    // 직원 정보
    const info = [
      ["성명", emp.name || "", "사번", emp.empNo || ""],
      ["부서", [emp.dept, emp.team].filter(Boolean).join(" / "), "직급", emp.rank || ""],
      ["직책", emp.position || "", "입사일", emp.hire || ""],
    ];
    info.forEach(([k1, v1, k2, v2]) => {
      doc.font("Korean").fontSize(9.5).fillColor("#334155");
      doc.text(k1, left + 6, state.y, { width: 60, lineBreak: false });
      doc.fillColor("#0f172a").text(String(v1), left + 66, state.y, { width: width * 0.4 - 66, lineBreak: false, ellipsis: true });
      doc.fillColor("#334155").text(k2, left + width / 2, state.y, { width: 60, lineBreak: false });
      doc.fillColor("#0f172a").text(String(v2), left + width / 2 + 60, state.y, { width: width / 2 - 66, lineBreak: false, ellipsis: true });
      state.y += 18;
    });
    state.y += 10;

    section(doc, state, "지급 내역");
    (slip.payItems || []).forEach(it => row(doc, state, it.label, it.amount));
    row(doc, state, "지급 합계", slip.gross, { bold: true, size: 10.5 });
    state.y += 10;

    section(doc, state, "공제 내역");
    (slip.deductItems || []).filter(it => Number(it.amount) > 0).forEach(it => row(doc, state, it.label, it.amount));
    row(doc, state, "공제 합계", slip.totalDeduct, { bold: true, size: 10.5 });
    state.y += 14;

    // 실수령액
    if (state.y > doc.page.height - doc.page.margins.bottom - 60) {
      doc.addPage();
      state.y = doc.page.margins.top;
    }
    doc.rect(left, state.y, width, 34).fillAndStroke("#ecfdf5", "#99f6e4");
    doc.font("Korean").fontSize(12).fillColor("#065f46").text("실수령액", left + 10, state.y + 10, { lineBreak: false });
    doc.text(money(slip.netPay), left + 10, state.y + 10, { width: width - 20, align: "right", lineBreak: false });
    state.y += 50;

    doc.font("Korean").fontSize(8).fillColor("#64748b").text(
      "본 명세서는 시스템에서 자동 계산된 참고용 자료입니다. 세액 등 최종 금액은 회사 급여 기준 및 관계 법령에 따라 확인하세요.",
      left, state.y, { width, lineBreak: true }
    );

    doc.end();
  });
}

module.exports = { renderPayslipPdf, FONT_PATH, money };
