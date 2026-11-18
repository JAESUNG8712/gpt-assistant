"use strict";
// 재고평가(이동평균 / FIFO) — 추가 전용 재고 원장에서 품목별 재고 금액을 계산하는 순수 함수.
//
// 원장 행: { itemId, locationId, type:"in"|"out", qty, refType, unitCost?, createdAt }
//  - 입고 행의 단가는 `unitCost`(발주 입고·단가를 입력한 수동 입고)에서 읽는다.
//    단가가 없으면 품목 마스터 단가(item.unitCost)를 쓰고 "추정" 행으로 센다.
//  - 반품 입고(quotation_return)처럼 단가가 없는 입고는 그 시점의 평균 단가를 쓴다.
//  - 창고 이동(refType:"transfer")은 회사 전체 기준으로 합계가 0이므로 평가에서 제외한다.
//  - 출고가 보유 수량보다 많으면(마이너스 재고) 부족분은 마지막으로 알려진 단가로 평가한다.
// 결과는 품목 단위(전 창고 합산)다. asOf(YYYY-MM-DD)를 주면 그 날짜 끝까지의 원장만 반영한다.

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function _round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }
function _day(createdAt) { return String(createdAt || "").slice(0, 10); }

function valuateItem(rows, fallbackCost) {
  const fallback = Math.max(0, _num(fallbackCost));
  // 이동평균 상태
  let avgQty = 0, avgValue = 0;
  // FIFO 상태: 입고 층(가장 오래된 것이 앞)
  const layers = [];
  let lastCost = fallback;
  let estimatedRows = 0;

  for (const row of rows) {
    const qty = Math.abs(_num(row.qty));
    if (!qty) continue;
    if (row.type === "out") {
      // 이동평균: 현재 평균 단가로 출고
      const avgCost = avgQty > 0 ? avgValue / avgQty : lastCost;
      const take = Math.min(qty, Math.max(avgQty, 0));
      avgValue -= take * avgCost;
      avgQty -= take;
      if (qty > take) avgQty -= (qty - take); // 마이너스 재고는 수량만 반영(금액 0)
      // FIFO: 오래된 층부터 소진
      let need = qty;
      while (need > 0 && layers.length) {
        const layer = layers[0];
        const use = Math.min(need, layer.qty);
        layer.qty -= use;
        need -= use;
        if (layer.qty <= 1e-9) layers.shift();
      }
    } else {
      let cost;
      if (row.unitCost !== undefined && row.unitCost !== null && row.unitCost !== "" && _num(row.unitCost) >= 0) {
        cost = _num(row.unitCost);
      } else if (row.refType === "quotation_return" && avgQty > 0) {
        cost = avgValue / avgQty; estimatedRows++;
      } else {
        cost = fallback; estimatedRows++;
      }
      lastCost = cost;
      if (avgQty < 0) {
        // 마이너스 재고를 먼저 메우고 남은 수량만 평가 대상이 된다.
        const fill = Math.min(qty, -avgQty);
        avgQty += fill;
        const rest = qty - fill;
        if (rest > 0) { avgQty += rest; avgValue += rest * cost; layers.push({ qty: rest, cost }); }
      } else {
        avgQty += qty; avgValue += qty * cost; layers.push({ qty, cost });
      }
    }
  }
  const qtyOnHand = Math.max(avgQty, 0);
  const fifoQty = layers.reduce((s, l) => s + l.qty, 0);
  const fifoValue = layers.reduce((s, l) => s + l.qty * l.cost, 0);
  return {
    qty: _round2(avgQty),
    avg: { value: _round2(Math.max(avgValue, 0)), unitCost: qtyOnHand > 0 ? _round2(avgValue / qtyOnHand) : 0 },
    fifo: { value: _round2(fifoValue), unitCost: fifoQty > 0 ? _round2(fifoValue / fifoQty) : 0 },
    estimatedRows,
  };
}

// ledger: 전체 원장 배열(순서는 저장 순서), items: 품목 마스터 배열.
function computeStockValuation(ledger, items, opts = {}) {
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf || "")) ? String(opts.asOf) : "";
  const byItem = new Map();
  (ledger || []).forEach((row, i) => {
    if (!row || row.refType === "transfer") return;
    if (asOf && _day(row.createdAt) > asOf) return;
    const key = String(row.itemId);
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push({ ...row, _i: i });
  });
  const itemMap = new Map((items || []).map(it => [String(it.id), it]));
  const out = [];
  let totalAvg = 0, totalFifo = 0, totalEstimated = 0;
  for (const [itemId, rows] of byItem) {
    rows.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a._i - b._i);
    const item = itemMap.get(itemId);
    const r = valuateItem(rows, item ? item.unitCost : 0);
    out.push({ itemId, name: item ? item.name : "", code: item ? item.code : "", unit: item ? item.unit : "", ...r });
    totalAvg += r.avg.value; totalFifo += r.fifo.value; totalEstimated += r.estimatedRows;
  }
  out.sort((a, b) => String(a.code || a.name).localeCompare(String(b.code || b.name)));
  return {
    asOf: asOf || null,
    items: out,
    totals: { avg: _round2(totalAvg), fifo: _round2(totalFifo), estimatedRows: totalEstimated },
  };
}

module.exports = { computeStockValuation, valuateItem };
