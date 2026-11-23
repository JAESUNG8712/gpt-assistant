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

// ── 창고(위치)별 평가 ─────────────────────────────────────────────────────────
// 품목 단위(전 창고 합산) 평가와 달리 위치마다 별도의 이동평균/FIFO 상태를 유지한다.
// 창고 이동(refType:"transfer")은 같은 refId의 출고·입고 쌍을 짝지어 출발 창고에서 빠져나간
// 단가(이동평균 단가, FIFO 층)가 도착 창고로 그대로 따라가게 한다. 쌍을 찾지 못한 이동 입고는
// 품목 마스터 단가(추정)로 평가한다. 위치별 합계는 전 창고 합산 평가와 단가 흐름이 달라 금액이
// 서로 다를 수 있다(참고용).
function _newState(fallback) {
  return { avgQty: 0, avgValue: 0, layers: [], lastCost: fallback };
}
function _stateOut(st, qty) {
  const avgCost = st.avgQty > 0 ? st.avgValue / st.avgQty : st.lastCost;
  const take = Math.min(qty, Math.max(st.avgQty, 0));
  st.avgValue -= take * avgCost;
  st.avgQty -= take;
  if (qty > take) st.avgQty -= (qty - take);
  const consumed = [];
  let need = qty;
  while (need > 0 && st.layers.length) {
    const layer = st.layers[0];
    const use = Math.min(need, layer.qty);
    layer.qty -= use;
    need -= use;
    consumed.push({ qty: use, cost: layer.cost });
    if (layer.qty <= 1e-9) st.layers.shift();
  }
  return { avgCost, consumed };
}
function _stateIn(st, qty, cost, layerList) {
  st.lastCost = cost;
  if (st.avgQty < 0) {
    const fill = Math.min(qty, -st.avgQty);
    st.avgQty += fill;
    const rest = qty - fill;
    if (rest > 0) { st.avgQty += rest; st.avgValue += rest * cost; st.layers.push({ qty: rest, cost }); }
  } else {
    st.avgQty += qty; st.avgValue += qty * cost;
    if (layerList && layerList.length) layerList.forEach(l => st.layers.push({ qty: l.qty, cost: l.cost }));
    else st.layers.push({ qty, cost });
  }
}
function _stateResult(st, estimatedRows) {
  const qtyOnHand = Math.max(st.avgQty, 0);
  const fifoQty = st.layers.reduce((s, l) => s + l.qty, 0);
  const fifoValue = st.layers.reduce((s, l) => s + l.qty * l.cost, 0);
  return {
    qty: _round2(st.avgQty),
    avg: { value: _round2(Math.max(st.avgValue, 0)), unitCost: qtyOnHand > 0 ? _round2(st.avgValue / qtyOnHand) : 0 },
    fifo: { value: _round2(fifoValue), unitCost: fifoQty > 0 ? _round2(fifoValue / fifoQty) : 0 },
    estimatedRows,
  };
}

function valuateItemByLocation(rows, fallbackCost) {
  const fallback = Math.max(0, _num(fallbackCost));
  const states = new Map();      // locationId -> state
  const estimated = new Map();   // locationId -> 추정 입고 건수
  const pending = new Map();     // transfer refId -> 출발 창고에서 빠져나간 단가 정보
  const stateOf = loc => { if (!states.has(loc)) { states.set(loc, _newState(fallback)); estimated.set(loc, 0); } return states.get(loc); };
  for (const row of rows) {
    const qty = Math.abs(_num(row.qty));
    if (!qty) continue;
    const loc = String(row.locationId == null ? "" : row.locationId);
    const st = stateOf(loc);
    if (row.type === "out") {
      const taken = _stateOut(st, qty);
      if (row.refType === "transfer" && row.refId != null) pending.set(String(row.refId), taken);
    } else if (row.refType === "transfer" && row.refId != null && pending.has(String(row.refId))) {
      const taken = pending.get(String(row.refId));
      pending.delete(String(row.refId));
      _stateIn(st, qty, taken.avgCost, taken.consumed);
    } else {
      let cost;
      if (row.unitCost !== undefined && row.unitCost !== null && row.unitCost !== "" && _num(row.unitCost) >= 0) {
        cost = _num(row.unitCost);
      } else if (row.refType === "quotation_return" && st.avgQty > 0) {
        cost = st.avgValue / st.avgQty; estimated.set(loc, estimated.get(loc) + 1);
      } else {
        cost = fallback; estimated.set(loc, estimated.get(loc) + 1);
      }
      _stateIn(st, qty, cost);
    }
  }
  const out = [];
  for (const [loc, st] of states) out.push({ locationId: loc, ..._stateResult(st, estimated.get(loc)) });
  return out;
}

function computeLocationValuation(ledger, items, opts = {}) {
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf || "")) ? String(opts.asOf) : "";
  const names = opts.locationNames || {};
  const byItem = new Map();
  (ledger || []).forEach((row, i) => {
    if (!row) return;
    if (asOf && _day(row.createdAt) > asOf) return;
    const key = String(row.itemId);
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push({ ...row, _i: i });
  });
  const itemMap = new Map((items || []).map(it => [String(it.id), it]));
  const byLoc = new Map();
  for (const [itemId, rows] of byItem) {
    // 같은 시각의 이동 출고·입고는 출고가 먼저 처리돼야 단가가 도착 창고로 따라간다. 저장소가
    // 같은 시각의 행을 id 순서로 돌려줄 수 있어(PostgreSQL) 저장 순서에 기대지 않고 명시한다.
    const rank = r => (r.refType === "transfer" && r.type === "out" ? 0 : 1);
    rows.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || rank(a) - rank(b) || a._i - b._i);
    const item = itemMap.get(itemId);
    for (const r of valuateItemByLocation(rows, item ? item.unitCost : 0)) {
      if (!r.qty && !r.avg.value && !r.fifo.value) continue;
      if (!byLoc.has(r.locationId)) byLoc.set(r.locationId, []);
      byLoc.get(r.locationId).push({ itemId, name: item ? item.name : "", code: item ? item.code : "", unit: item ? item.unit : "", ...r });
    }
  }
  const locations = [];
  let totalAvg = 0, totalFifo = 0;
  for (const [locationId, list] of byLoc) {
    list.sort((a, b) => String(a.code || a.name).localeCompare(String(b.code || b.name)));
    const avg = _round2(list.reduce((s, x) => s + x.avg.value, 0));
    const fifo = _round2(list.reduce((s, x) => s + x.fifo.value, 0));
    totalAvg += avg; totalFifo += fifo;
    locations.push({ locationId, name: names[locationId] || "", items: list, totals: { avg, fifo } });
  }
  locations.sort((a, b) => String(a.name || a.locationId).localeCompare(String(b.name || b.locationId)));
  return { asOf: asOf || null, locations, totals: { avg: _round2(totalAvg), fifo: _round2(totalFifo) } };
}

module.exports = { computeStockValuation, valuateItem, computeLocationValuation, valuateItemByLocation };
