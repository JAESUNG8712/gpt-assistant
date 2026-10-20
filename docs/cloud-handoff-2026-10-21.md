# HR/ERP 클라우드 개발 인수인계

## 작업 기준과 경계

- 저장소: `JAESUNG8712/gpt-assistant`
- 이어갈 브랜치: `codex/post-merge-integrity-qa`
- PR 대상: `hr-production`. `main`이나 예전 Claude HR 브랜치를 임의로 기준으로 삼지 않는다.
- 운영 서비스는 Render HR 앱이다. Vercel 연결/배포를 되살리지 않는다.
- `claude/account-pinned-agents-v6W7p`와 `ai/`는 별도 앱이다. 이 HR 점검에 통합하지 않는다. 루트 `CLAUDE.md`의 별도 AI 앱 설명과 개발 브랜치를 혼동하지 않는다.
- 운영 DB, 직원 원본, 급여, 비밀값, 실제 그룹웨어 계정은 클라우드에 복사하지 않는다. 테스트에는 합성 자료와 폐기 가능한 로컬 PostgreSQL만 사용한다.
- 이 문서는 개발 인수인계이며 운영 배포/DB 이전 승인이 아니다. 병합·배포는 별도 승인 전 수행하지 않는다.

## 이번 변경

1. 수정·삭제 이력 조회/복구에도 해당 업무 메뉴와 회사 모듈 권한을 적용한다. 제한된 관리자가 history 메뉴로 업무 제한을 우회하지 못한다.
2. 큰 본문이 생략된 이력은 `409 REVISION_INCOMPLETE`로 복구를 거부한다. 생략된 자료를 빈 값으로 복구하지 않는다.
3. 확정 급여 등 저장 규칙에 의해 거부된 복구를 성공으로 알리지 않고 `409 REVISION_RESTORE_REJECTED`로 응답한다.
4. 알림 대기함 작업자는 자동/수동 재전송 시 회사 정지와 회사 모듈 차단을 확인한다. 기존 권한 캐시의 최대 10초 유효기간은 유지한다.
5. CI 실패 시 `test-results/`의 Playwright trace·스크린샷도 업로드한다.
6. 원격 PR #159/#160의 정리와 통합한다. 삭제된 `isFeatureEnabled()`에 신규 코드가 의존하지 않도록 기존 `_getCompanyFeatureMap()`을 사용한다.

수정 관련 파일: `server.js`, `test/api-record-revisions.test.js`, `test/api/postgres-mode.test.js`, `.github/workflows/ci.yml`.
JSON 복구는 employees/kpiEntries의 전체 목록 저장 의미를 유지해야 한다. 복구할 한 행만 전달하면 다른 직원이 삭제될 수 있으므로 전체 현재 목록을 유지하는 코드를 축약하지 않는다.

## 클라우드 환경 준비

GitHub에 올라온 위 브랜치를 선택하고 이 문서를 먼저 읽는다. 새 작업의 첫 명령은 `git status --short --branch`와 `git log -5 --oneline`으로 실제 브랜치와 변경분을 확인한다. 로컬 PC 로그인 세션이나 설치 경로가 전달된다고 가정하지 않는다.

CI와 맞추려면 Node.js 20 및 PostgreSQL 16을 사용한다. Node 업그레이드는 별도 회귀 검증 후 진행한다. 의존성 설치에는 npm registry 외 SheetJS 패키지 호스트(`cdn.sheetjs.com`) 접근도 필요하다. 인증서 검증을 끄지 않는다.

```bash
# 격리된 개발 셸에서만 실행. 운영 접속값을 전달받지 않는다.
unset DATABASE_URL TEST_DATABASE_URL
export NODE_ENV=test
npm ci --include=optional
npm run check
npm test
npx playwright install --with-deps chromium
npm run test:e2e
```

PostgreSQL 테스트는 DB 생성/삭제 권한이 있는 **폐기 가능한 로컬 테스트 인스턴스**가 필요하다. `.github/workflows/ci.yml`의 `services.postgres` 구성을 기준으로 준비한다. 준비한 인스턴스의 URL만 `TEST_DATABASE_URL`로 지정하고 `npm run test:postgres`를 실행한다. 일부 테스트는 `DATABASE_URL`로 fallback하므로 운영 URL은 두 변수 어느 쪽에도 넣지 않는다. PostgreSQL이 없는 경우 건너뛴 테스트를 통과로 기록하지 말고 GitHub CI 결과를 확인한다.

테스트가 설치 권한·브라우저/네트워크 정책에 막히면 보안 설정을 해제하거나 운영 환경으로 바꾸지 말고, 제약과 실행하지 못한 검증을 기록한다.

## 검증 현황

최종 결과는 아래에 갱신한다. 이전 PR의 성공을 이번 커밋의 성공으로 대신하지 않는다.

- 정적 검사: 이번 작업에서 package.json의 check 명령들을 Node로 직접 실행해 통과.
- 최초 제한된 네트워크 환경 실행: 단위 테스트 6건 통과, API 8건은 서버 시작 로그가 있었으나 localhost 접근 시간 초과로 실패. 이후 권한을 받은 실행에서 임시 서버 연결 성공. 실패를 숨기거나 테스트를 삭제하지 않는다.
- 통합 전 로컬 전체 회귀(1056c24): 497건 중 487 통과, 실패 0, PostgreSQL 환경 의존 10건 건너뜀. npm 래퍼가 출력 없이 종료되어 package.json의 동일 테스트 목록을 Node로 직접 실행했다.
- 복구·outbox 집중 회귀: 14/14 통과. 최신 원격 `c9c3eb8`(#159/#160)을 정상 병합하고 삭제된 함수 의존성을 제거했다.
- 최종 통합 코드의 PostgreSQL·브라우저 및 전체 테스트 판단은 **이 브랜치의 최신 head에 대한 GitHub Actions 결과**를 확인한다. 커밋 전의 성공을 최종 CI 성공으로 간주하지 않는다.

## 남은 작업 — 완료로 오해하지 말 것

`docs/qa-consolidation-2026-10-19.md`는 PR #157 당시 기록이다. #158에서 회계 CAS 필수화·영속 outbox·복구 이력이 추가되어 일부 항목은 이미 바뀌었다. 아래 현재 목록을 우선한다.

1. **업무 저장과 outbox enqueue의 원자성**: 영속 대기함은 있으나 업무 저장과 dispatch 요청이 별도다. 저장 직후 브라우저 종료 시 enqueue 전 공백을 제거하는 설계와 장애 재현 테스트가 필요하다.
2. **outbox lease 소유권**: 만료 후 다른 작업자가 가져간 건을 이전 작업자가 완료 처리할 수 있는지 확인하고 필요하면 claim token 조건부 갱신을 적용한다. 외부 서비스 지원 없이 exactly-once 전달을 약속하지 않는다.
3. **이력 복구 동시성·원자성**: 현재 자료 preview/revision 비교, 저장·복구 이력의 동일 트랜잭션 처리, 오래된 오프라인 tombstone의 복구 자료 재삭제 가능성을 각각 재현한다.
4. **재전송 시 실행 주체 권한**: 회사/모듈 재검사는 이번 수정 범위다. 최초 요청자 퇴사·개인 권한 철회를 대기 이벤트에 반영할지 정책 및 구현을 검토한다.
5. **이력 비밀정보·보관 정책**: 상위 pw 필드 외 중첩 민감값과 첨부를 검사하고, 보관·내보내기·삭제 미리보기 정책을 정한다. 기존 이력을 일괄 삭제하지 않는다.
6. **교육 원장 연결**: 공통 과정 ID와 관리자 연결/해제 UI. 이름만 같다고 합치거나 비용·이력을 자동 중복 삭제하지 않는다.
7. **업무 UI E2E 확대**: 평가자 선정→평가 확정→보상·급여, 경비→전표, 권한 변경→열린 탭의 재동기화를 관리자/직원/모바일별 저장·재조회까지 검증한다.
8. **권한·도메인 코드 분리**: 기능별 회귀 테스트를 유지하며 작은 단위로 추출한다. 대규모 재작성이나 근거 없는 기술 추가를 우선하지 않는다.

위 목록에는 설계 위험/미검증 가설도 포함되어 있다. 모두 재현된 취약점이라고 보고하지 말고, 재현→최소 수정→회귀 검증 순서로 진행한다.

## 클라우드 작업 시작용 요청

> `JAESUNG8712/gpt-assistant`의 `codex/post-merge-integrity-qa`에서 이어서 작업하세요. `docs/cloud-handoff-2026-10-21.md`를 먼저 읽고 현재 Git 상태·해당 커밋 CI부터 확인하세요. HR 앱만 대상으로 하며 운영 DB/배포/비밀정보는 변경하지 마세요. 격리 테스트를 완료한 뒤 문서의 남은 작업을 우선순위대로 재현·개선하고, 검증된 사실과 미검증 항목을 종합 보고하세요. 다른 AI 변경을 보존하고 강제 푸시하지 마세요. PR은 hr-production 대상으로 검토용으로 준비하되 병합/배포는 별도 승인을 받으세요.
