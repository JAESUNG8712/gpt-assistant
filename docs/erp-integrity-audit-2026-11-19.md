# ERP 읽기 전용 무결성 점검

기존 데이터의 문제 후보를 찾는 운영자용 도구다. 데이터 수정·삭제·자동 귀속·스키마 변경·서버 기동은 하지 않는다. 발견된 문제가 없더라도 HR/급여/회계 전체 데이터가 정상이라는 의미는 아니다.

## 실행

PowerShell의 프로젝트 폴더에서 도움말을 확인한다.

```powershell
node scripts/audit-erp-integrity.js --help
```

JSON 모드에서는 사용자가 선택한 ERP 파일 사본을 읽는다. 메인 HR JSON이나 통합 DB 백업 파일이 아니라 `items`, `locations`, `quotations`, `purchaseOrders`, `purchaseRequests`, `stockLedger` 배열이 모두 있는 ERP 스냅샷을 사용한다. 파일을 수정하지 않는다.

```powershell
$AuditFile = Read-Host "ERP JSON 사본의 전체 경로"
node scripts/audit-erp-integrity.js --file $AuditFile
$LASTEXITCODE
```

PostgreSQL 모드에서는 기존 `DATABASE_URL` 환경변수와 명시한 회사 UUID를 사용한다. URL이나 비밀번호를 명령 인수에 넣거나 채팅으로 전달하지 않는다. 읽기 권한만 있는 DB 계정 사용을 권장한다. TLS 설정은 접속 URL/드라이버 설정을 따르며 이 도구가 인증서 검증을 해제하지 않는다.

```powershell
$AuditCompanyId = Read-Host "점검할 회사 UUID"
node scripts/audit-erp-integrity.js --company-id $AuditCompanyId
$LASTEXITCODE
```

같은 명령은 `npm.cmd run audit:erp-integrity -- --company-id $AuditCompanyId`로 실행할 수 있다. 연결 정보를 설정하지 않았거나 회사가 존재하지 않으면 실패한다. JSON 파일과 회사를 동시에 지정할 수 없다.

## 결과와 안전장치

- 종료코드 `0`: 지원하는 점검 범위에서 발견 없음.
- 종료코드 `2`: 문제 후보 또는 회사 미지정 행이 있음. 자동으로 수정하지 않는다.
- 종료코드 `1`: 실행 실패·불완전한 자료·스키마 불일치·용량 초과. 정상 판정으로 취급하지 않는다.
- `issues[].count`는 발견 횟수이며 고유 레코드 수가 아니다. 하나의 문서에서 여러 문제가 발견될 수 있다.
- `samples`는 컬렉션과 1부터 시작하는 행 위치만 제공한다. JSON은 입력 배열 순서, PostgreSQL은 해당 회사의 `ORDER BY id` 순서다. 이름, 메모, 금액, 원문 ID, 접속 URL을 출력하지 않는다. 검사 후 변경된 DB의 행 위치는 달라질 수 있으므로 같은 시점의 사본과 대조한다.
- 기본 유형별 예시는 최대 10개이며 나머지 개수는 `omitted`에 표시한다. `--sample-limit 0`은 집계만 출력한다. 예시 제한은 전체 점검 건수를 제한하지 않는다.
- PostgreSQL은 `REPEATABLE READ READ ONLY` 트랜잭션으로 한 시점의 데이터를 검사하고 종료 시 롤백한다. 현재 회사 데이터만 읽어 연결을 판단한다.
- `unassignedRows`는 전체 DB의 회사 미지정 행 개수다. 현재 회사 소유라고 추정하지 않으며 해당 행의 내용도 읽지 않는다.
- 최대 5만 행/50 MiB, SQL당 15초, 잠금 대기 2초 제한이 있다. 제한을 넘으면 부분 점검 결과를 정상 보고서로 출력하지 않는다.

## 확인하는 항목

| 코드 | 검토 내용 |
| --- | --- |
| INVALID_RECORD_ID / DUPLICATE_RECORD_ID | 누락·잘못된 ID 또는 컬렉션 내 중복 ID |
| COLUMN_DATA_MISMATCH | PostgreSQL 실제 컬럼과 JSON 내부 ID·문서 상태·재고 참조 값의 불일치 |
| MISSING_ITEM_CODE / DUPLICATE_ACTIVE_ITEM_CODE | 사용 중인 품목의 코드 누락/중복. 앞뒤 공백만 제거하고 대소문자는 구분 |
| MISSING_REFERENCE / ORPHAN_REFERENCE | 필수 품목·창고·문서 연결 누락 또는 대상 없음 |
| DELETED_MASTER_REFERENCE / LIVE_TOMBSTONE | 삭제 자료 참조 또는 살아 있는 자료와 JSON 삭제 표식의 모순 |
| INVALID_DOCUMENT_LINES / INVALID_DOCUMENT_AMOUNT | 문서 라인 또는 수량/단가 형식 오류 |
| BROKEN_PURCHASE_LINK | 전환된 구매요청과 발주서의 양방향 연결 불일치 |
| INVALID_STOCK_ENTRY / INVALID_STOCK_TOTAL | 재고 이력의 방향·수량·집계 숫자 오류 |
| NEGATIVE_STOCK_BALANCE | 품목/창고별 최종 잔고가 음수. 부동소수점 오차 1e-9 이하는 허용 |

비활성 품목을 과거 문서가 참조하는 것은 허용한다. 자유 입력 견적은 출고 전에는 품목 연결을 필수로 요구하지 않는다. 부분 출고·입고, 반품, 견적 할인·복사로 실제 생성된 자료도 회귀 테스트에 포함한다. 같은 품목을 서로 다른 단가로 여러 견적 줄에 사용하거나 재고 이력이 반복된다는 이유만으로 중복으로 판정하지 않는다.

## 검증과 남은 범위

로컬 단위·CLI 테스트는 원본 불변, 오류 탐지, 정상 자료 오탐 방지, 출력 정보 제한과 종료코드를 검증한다. CI에서는 임시 PostgreSQL DB를 생성해 회사 격리, 읽기 전용 상태, 원본 불변, 동시 삽입 중 일관된 스냅샷, 실패 후 트랜잭션 종료를 확인한다.

이 개발 과정에서 운영 DB는 점검하거나 변경하지 않았다. 운영 자료의 실제 문제 유무는 권한 있는 운영자가 명시한 회사에서 이 도구를 실행한 결과로 판단해야 한다. 회계 전표/세금계산서의 금액 대사, HR·급여 연결, 활성 마스터의 동시 편집 revision 보호는 별도 범위다. DB 중복 후보를 자동 삭제하거나 NULL 회사 자료를 임의의 회사에 귀속하지 않는다.
