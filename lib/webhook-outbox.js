"use strict";
// 웹훅 발송 대기함(outbox)의 순수 로직.
//
// 예전에는 웹훅 발송이 (1) 브라우저 메모리의 대기열에서 (2) 한 번만 시도되고 (3) 성공·실패와
// 무관하게 중복 방지 키가 48시간 선점돼, 탭을 닫거나 수신 서버가 잠깐 죽으면 알림이 영구히 사라졌다.
// 이제 서버가 "보낼 알림"을 먼저 영속 저장하고, 실패하면 지연 시간을 늘려가며 재시도하며,
// 끝내 실패한 건은 관리자가 목록에서 확인해 다시 보낼 수 있다. 이 모듈은 그 상태 전이만 담당한다.

const DEFAULT_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]; // 1분,5분,30분,2시간,6시간
const SENDING_LEASE_MS = 120_000; // 접수 직후/처리 중 다른 워커가 가로채지 않는 시간(프로세스가 죽으면 이후 회수)

function retryDelays(envValue) {
  const parsed = String(envValue || "").split(",").map(x => x.trim()).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : DEFAULT_RETRY_DELAYS_MS;
}

// 시도 결과를 반영한 다음 상태. attempts는 지금까지의 총 시도 횟수(이번 시도 포함).
function nextOutboxState(entry, outcome, message, nowMs, delays) {
  const attempts = (entry.attempts || 0) + 1;
  const iso = new Date(nowMs).toISOString();
  if (outcome === "sent") return { status: "sent", attempts, lastError: "", sentAt: iso, nextAttemptAt: iso };
  if (outcome === "cancelled") return { status: "cancelled", attempts: entry.attempts || 0, lastError: String(message || "").slice(0, 300), nextAttemptAt: iso };
  // 실패: 남은 재시도 간격이 없으면 중단(dead) — 관리자가 수동 재전송할 수 있다.
  if (attempts > delays.length) return { status: "dead", attempts, lastError: String(message || "").slice(0, 300), nextAttemptAt: iso };
  return { status: "pending", attempts, lastError: String(message || "").slice(0, 300), nextAttemptAt: new Date(nowMs + delays[attempts - 1]).toISOString() };
}

module.exports = { DEFAULT_RETRY_DELAYS_MS, SENDING_LEASE_MS, retryDelays, nextOutboxState };
