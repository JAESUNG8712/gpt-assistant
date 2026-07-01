"""
법률 지식베이스 정확도 테스트 — 65개 항목 전수 검사
각 항목당 5~8개 쿼리 변형으로 TF-IDF 엔진 정확도 측정
"""

import sys
import os

# ── 모듈 캐시 초기화 (fresh import) ──────────────────────────────
mods_to_del = [k for k in sys.modules if 'knowledge' in k or 'engine' in k]
for m in mods_to_del:
    del sys.modules[m]

# ai 디렉토리를 sys.path 앞에 추가
ai_dir = os.path.dirname(os.path.abspath(__file__))
if ai_dir not in sys.path:
    sys.path.insert(0, ai_dir)

# ── 엔진 로드 (legal KB만) ────────────────────────────────────────
from engine import _Engine, _feat

def build_legal_only_engine():
    """legal.py + legal2.py 항목만 포함한 엔진 반환"""
    from knowledge_legal import LEGAL_KNOWLEDGE
    from knowledge_legal2 import LEGAL_KNOWLEDGE2

    eng = _Engine()
    entries = []

    for item in LEGAL_KNOWLEDGE + LEGAL_KNOWLEDGE2:
        entries.append(item)
        eng.add(item['q'], item['a'], {'persona': item.get('persona', 'hr')})

    eng._build()
    return eng, entries

print("엔진 빌드 중...")
engine, entries = build_legal_only_engine()
print(f"총 {len(entries)}개 항목 로드 완료\n")


# ── 쿼리 변형 정의 ────────────────────────────────────────────────
# 각 튜플: (entry_index, query_text)
# entry_index는 entries[] 리스트에서의 위치

def make_queries(entries):
    """각 항목에 대해 5~8개의 다양한 쿼리 생성"""
    all_queries = []  # [(entry_idx, query, label), ...]

    for idx, item in enumerate(entries):
        q_field = item['q']
        # q 필드에서 첫 번째 실질 키워드 추출 (반복된 첫 구절 기준)
        q_parts = q_field.strip().split()
        # q 필드는 보통 "키워드 키워드 키워드 ..." 형태로 반복됨
        # 첫 2~4어절이 핵심 키워드
        first_kw = ' '.join(q_parts[:2]) if len(q_parts) >= 2 else q_parts[0]

        entry_queries = []

        # ── 항목별 수동 정의 쿼리 ─────────────────────────────────
        # index 0: 부당해고 판례
        if idx == 0:
            entry_queries = [
                ("exact", "부당해고 판례"),
                ("exact", "부당해고 기준"),
                ("natural", "억울하게 해고당했는데 부당해고인가요"),
                ("natural", "정당한 해고 사유가 뭔가요"),
                ("natural", "부당해고 대법원 판결 알려줘"),
                ("partial", "해고 무효 판례"),
                ("partial", "해고 정당한 이유"),
                ("edge", "부당해고판례 대법원"),
            ]

        # index 1: 포괄임금제 판례
        elif idx == 1:
            entry_queries = [
                ("exact", "포괄임금제 판례"),
                ("exact", "포괄임금제 적법 기준"),
                ("natural", "포괄임금제가 유효한 경우는 언제인가요"),
                ("natural", "야근수당 포괄임금으로 처리해도 되나요"),
                ("partial", "포괄임금 초과근무 대법원"),
                ("partial", "포괄임금 무효 조건"),
                ("edge", "포괄임금제판례"),
            ]

        # index 2: 직장내 괴롭힘 판례
        elif idx == 2:
            entry_queries = [
                ("exact", "직장내 괴롭힘 판례"),
                ("exact", "직장내괴롭힘 갑질"),
                ("natural", "상사가 반복적으로 욕설하는데 직장내 괴롭힘인가요"),
                ("natural", "직장 내 괴롭힘 신고 방법"),
                ("partial", "직장 괴롭힘 판단 기준"),
                ("partial", "근로기준법 76조 괴롭힘"),
                ("edge", "직장내괴롭힘판례 갑질"),
            ]

        # index 3: 권고사직 판례
        elif idx == 3:
            entry_queries = [
                ("exact", "권고사직 판례"),
                ("exact", "권고사직 부당해고"),
                ("natural", "권고사직 당했는데 실업급여 받을 수 있나요"),
                ("natural", "회사에서 사직서 내라고 압박하는데 어떻게 하나요"),
                ("partial", "권고사직 강요 판결"),
                ("partial", "권고사직 실업급여"),
                ("edge", "권고사직판례 강요"),
            ]

        # index 4: 통상임금 판례
        elif idx == 4:
            entry_queries = [
                ("exact", "통상임금 판례"),
                ("exact", "통상임금 대법원"),
                ("natural", "정기상여금이 통상임금에 포함되나요"),
                ("natural", "통상임금 고정성 판단 기준"),
                ("partial", "통상임금 정기성 일률성"),
                ("partial", "상여금 통상임금 포함"),
                ("edge", "통상임금판례 전합"),
            ]

        # index 5: 노동위원회 부당해고 구제신청
        elif idx == 5:
            entry_queries = [
                ("exact", "노동위원회 부당해고 구제신청"),
                ("exact", "부당해고 구제신청 절차"),
                ("natural", "부당해고 신청은 어디서 하나요"),
                ("natural", "노동위원회 구제신청 기간이 얼마나 되나요"),
                ("partial", "부당해고 3개월 이내 신청"),
                ("partial", "지방노동위원회 구제"),
                ("edge", "노동위원회구제신청 방법"),
            ]

        # index 6: 민법 계약 해제
        elif idx == 6:
            entry_queries = [
                ("exact", "민법 계약 해제"),
                ("exact", "계약 해지 취소"),
                ("natural", "계약을 해제하려면 어떻게 해야 하나요"),
                ("natural", "계약 해제와 해지의 차이"),
                ("partial", "이행지체 계약 해제"),
                ("partial", "민법 543조 계약"),
                ("edge", "계약해제 방법 민법"),
            ]

        # index 7: 소멸시효 기간
        elif idx == 7:
            entry_queries = [
                ("exact", "소멸시효 기간"),
                ("exact", "소멸시효 중단"),
                ("natural", "임금 청구권 시효가 몇 년인가요"),
                ("natural", "채권 소멸시효는 얼마나 되나요"),
                ("partial", "임금 퇴직금 3년 시효"),
                ("partial", "청구권 시효 기간"),
                ("edge", "소멸시효기간 중단"),
            ]

        # index 8: 내용증명 작성
        elif idx == 8:
            entry_queries = [
                ("exact", "내용증명 작성"),
                ("exact", "내용증명 효력"),
                ("natural", "내용증명 보내는 방법 알려줘"),
                ("natural", "내용증명이 뭔가요 어떻게 쓰나요"),
                ("partial", "내용증명 소멸시효 중단"),
                ("partial", "우체국 내용증명 발송"),
                ("edge", "내용증명작성 방법"),
            ]

        # index 9: 임차인 보증금 반환
        elif idx == 9:
            entry_queries = [
                ("exact", "임차인 보증금 반환"),
                ("exact", "전세 보증금 반환"),
                ("natural", "집주인이 보증금을 안 돌려주면 어떻게 하나요"),
                ("natural", "세입자 권리 보증금 못 받을 때"),
                ("partial", "임차권 등기명령 신청"),
                ("partial", "주택임대차보호법 대항력"),
                ("edge", "보증금반환 세입자 권리"),
            ]

        # index 10: 전월세 신고
        elif idx == 10:
            entry_queries = [
                ("exact", "전월세 신고"),
                ("exact", "확정일자 임대차 신고"),
                ("natural", "전입신고랑 확정일자 어떻게 받나요"),
                ("natural", "전월세 신고 안 하면 어떻게 되나요"),
                ("partial", "임대차신고제 30일"),
                ("partial", "확정일자 우선변제권"),
                ("edge", "전월세신고 확정일자"),
            ]

        # index 11: 형사고소 방법
        elif idx == 11:
            entry_queries = [
                ("exact", "형사고소 방법"),
                ("exact", "형사고소 절차 고소장"),
                ("natural", "상대방을 고소하려면 어떻게 하나요"),
                ("natural", "고소장 작성하는 방법"),
                ("partial", "경찰서 고소 접수"),
                ("partial", "고소 고발 차이"),
                ("edge", "형사고소방법 고소장"),
            ]

        # index 12: 손해배상 소송
        elif idx == 12:
            entry_queries = [
                ("exact", "손해배상 소송"),
                ("exact", "손해배상 청구 절차"),
                ("natural", "손해배상 소송은 어떻게 하나요"),
                ("natural", "민사소송으로 손해배상 받는 방법"),
                ("partial", "민법 750조 불법행위"),
                ("partial", "소액사건 손해배상"),
                ("edge", "손해배상소송 방법"),
            ]

        # index 13: 무료 법률 상담
        elif idx == 13:
            entry_queries = [
                ("exact", "무료 법률 상담"),
                ("exact", "법률구조공단 무료 서비스"),
                ("natural", "돈 없는데 변호사 도움 받을 수 있나요"),
                ("natural", "무료로 법률 상담 받는 곳"),
                ("partial", "대한법률구조공단 132"),
                ("partial", "무료 법률 지원 기관"),
                ("edge", "무료법률상담 공단"),
            ]

        # index 14: 판례 검색
        elif idx == 14:
            entry_queries = [
                ("exact", "판례 검색"),
                ("exact", "대법원 판례 무료"),
                ("natural", "대법원 판례 찾는 방법"),
                ("natural", "판례 무료로 볼 수 있는 사이트"),
                ("partial", "대법원 종합법률정보 검색"),
                ("partial", "헌법재판소 판례 검색"),
                ("edge", "판례검색 대법원"),
            ]

        # index 15: 소비자 피해 구제
        elif idx == 15:
            entry_queries = [
                ("exact", "소비자 피해 구제"),
                ("exact", "소비자원 신고 환불"),
                ("natural", "제품 불량인데 환불 안 해준다 어떻게 하나요"),
                ("natural", "한국소비자원에 신고하는 방법"),
                ("partial", "소비자분쟁조정 신청"),
                ("partial", "청약철회 소비자 권리"),
                ("edge", "소비자피해구제 방법"),
            ]

        # index 16: 근로계약서 없이 일하면
        elif idx == 16:
            entry_queries = [
                ("exact", "근로계약서 없이"),
                ("exact", "구두 계약 효력"),
                ("natural", "근로계약서 안 쓰고 일하면 어떻게 되나요"),
                ("natural", "계약서 없이 일한 퇴직금 받을 수 있나요"),
                ("partial", "서면 근로계약 미작성 벌금"),
                ("partial", "근로기준법 17조 계약서"),
                ("edge", "근로계약서없이 일하면"),
            ]

        # index 17: 해고 무효 소송
        elif idx == 17:
            entry_queries = [
                ("exact", "해고 무효 소송"),
                ("exact", "해고무효확인소송"),
                ("natural", "부당해고 소송 어떻게 하나요"),
                ("natural", "해고 무효 확인 소송 절차"),
                ("partial", "해고 3년 소멸시효 소송"),
                ("partial", "복직 임금 소급 판결"),
                ("edge", "해고무효소송 방법"),
            ]

        # index 18: 개인정보 침해
        elif idx == 18:
            entry_queries = [
                ("exact", "개인정보 침해"),
                ("exact", "개인정보 유출 보호법"),
                ("natural", "개인정보 유출되면 어떻게 신고하나요"),
                ("natural", "내 개인정보 무단 사용됐는데 어디에 신고하나요"),
                ("partial", "개인정보보호위원회 118"),
                ("partial", "개인정보 침해 손해배상"),
                ("edge", "개인정보침해 신고"),
            ]

        # index 19: 법인 설립 방법
        elif idx == 19:
            entry_queries = [
                ("exact", "법인 설립 방법"),
                ("exact", "주식회사 설립 절차"),
                ("natural", "회사 법인을 설립하려면 어떻게 하나요"),
                ("natural", "주식회사 만드는 방법"),
                ("partial", "법인 등기 설립 자본금"),
                ("partial", "1인 법인 창업"),
                ("edge", "법인설립 방법 주식회사"),
            ]

        # index 20: 교통사고 처리
        elif idx == 20:
            entry_queries = [
                ("exact", "교통사고 처리"),
                ("exact", "교통사고 보험 합의"),
                ("natural", "교통사고 나면 어떻게 해야 하나요"),
                ("natural", "교통사고 합의할 때 주의할 점"),
                ("partial", "사고 과실 비율 협의"),
                ("partial", "교통사고 11대 중과실"),
                ("edge", "교통사고처리 방법"),
            ]

        # index 21: 사기죄 성립
        elif idx == 21:
            entry_queries = [
                ("exact", "사기죄 성립"),
                ("exact", "사기죄 요건"),
                ("natural", "돈 빌려줬는데 안 갚으면 사기인가요"),
                ("natural", "사기 피해 당했을 때 고소 방법"),
                ("partial", "형법 347조 사기"),
                ("partial", "보이스피싱 피해 신고"),
                ("edge", "사기죄성립 요건"),
            ]

        # index 22: 명예훼손 성립
        elif idx == 22:
            entry_queries = [
                ("exact", "명예훼손 성립"),
                ("exact", "사이버 명예훼손 SNS"),
                ("natural", "인터넷에 허위 사실 올리면 명예훼손인가요"),
                ("natural", "카톡으로 욕설하면 법적 문제 되나요"),
                ("partial", "정보통신망법 명예훼손"),
                ("partial", "모욕죄 명예훼손 차이"),
                ("edge", "명예훼손성립 SNS"),
            ]

        # index 23: 유언장 작성 / 상속
        elif idx == 23:
            entry_queries = [
                ("exact", "유언장 작성"),
                ("exact", "유류분 상속 포기"),
                ("natural", "유언장 어떻게 쓰나요"),
                ("natural", "상속 포기하려면 어떻게 해야 하나요"),
                ("partial", "한정승인 상속 포기 차이"),
                ("partial", "자필증서 유언 방식"),
                ("edge", "유언장작성 상속포기"),
            ]

        # ── knowledge_legal2.py 항목 (idx 24~64) ─────────────────

        # index 24: 주52시간 위반
        elif idx == 24:
            entry_queries = [
                ("exact", "주52시간 위반"),
                ("exact", "주52시간 근무제 초과"),
                ("natural", "주 52시간 넘게 일하면 회사가 처벌받나요"),
                ("natural", "연장근무 한도가 얼마나 되나요"),
                ("partial", "근로기준법 53조 연장근무"),
                ("partial", "주52시간 탄력근무제"),
                ("edge", "주52시간위반 처벌"),
            ]

        # index 25: 중대재해처벌법
        elif idx == 25:
            entry_queries = [
                ("exact", "중대재해처벌법 처벌"),
                ("exact", "중대재해처벌법 기업 CEO"),
                ("natural", "중대재해처벌법에서 CEO가 처벌받는 경우"),
                ("natural", "사업장 사망사고 경영자 처벌"),
                ("partial", "중대산업재해 사망 징역"),
                ("partial", "안전보건관리체계 의무"),
                ("edge", "중대재해처벌법처벌 내용"),
            ]

        # index 26: 최저임금 위반 신고
        elif idx == 26:
            entry_queries = [
                ("exact", "최저임금 위반 신고"),
                ("exact", "최저임금 처벌"),
                ("natural", "최저임금보다 적게 받고 있는데 신고할 수 있나요"),
                ("natural", "2025년 최저시급이 얼마인가요"),
                ("partial", "최저임금법 위반 벌금"),
                ("partial", "고용노동부 최저임금 진정"),
                ("edge", "최저임금위반신고 방법"),
            ]

        # index 27: 기간제 무기계약 전환
        elif idx == 27:
            entry_queries = [
                ("exact", "기간제 무기계약 전환"),
                ("exact", "기간제 2년 초과 판례"),
                ("natural", "2년 이상 계약직이면 정규직 돼야 하나요"),
                ("natural", "기간제 계약 갱신 기대권이란"),
                ("partial", "기간제법 4조 무기계약"),
                ("partial", "갱신 거절 부당해고"),
                ("edge", "기간제무기계약전환 방법"),
            ]

        # index 28: 임신 해고 금지
        elif idx == 28:
            entry_queries = [
                ("exact", "임신 해고"),
                ("exact", "임신 해고 금지"),
                ("natural", "임신 중에 해고당했는데 어떻게 해야 하나요"),
                ("natural", "출산 후 직장에 복귀했는데 불이익 받으면"),
                ("partial", "출산전후휴가 90일"),
                ("partial", "육아휴직 급여 개정"),
                ("edge", "임신해고 금지 법률"),
            ]

        # index 29: 직장내 성희롱 판례
        elif idx == 29:
            entry_queries = [
                ("exact", "직장내 성희롱 판례"),
                ("exact", "직장 성희롱 대처 방법"),
                ("natural", "직장에서 성희롱 당했을 때 어떻게 하나요"),
                ("natural", "상사 성희롱 신고 방법"),
                ("partial", "남녀고용평등법 성희롱"),
                ("partial", "성희롱 2차 피해 방지"),
                ("edge", "직장내성희롱 신고"),
            ]

        # index 30: 플랫폼 노동자 근로자성
        elif idx == 30:
            entry_queries = [
                ("exact", "플랫폼 노동자 근로자"),
                ("exact", "특수고용 프리랜서 근로자성"),
                ("natural", "배달기사가 근로자로 인정받을 수 있나요"),
                ("natural", "프리랜서도 노동법 적용받나요"),
                ("partial", "사용종속관계 근로자 인정"),
                ("partial", "배달 라이더 근로자 판례"),
                ("edge", "플랫폼노동자 근로자성"),
            ]

        # index 31: 계약갱신청구권
        elif idx == 31:
            entry_queries = [
                ("exact", "계약갱신청구권 거절"),
                ("exact", "임대차3법 전월세상한제"),
                ("natural", "집주인이 계약갱신 거절할 수 있는 경우"),
                ("natural", "세입자가 계약갱신 요청할 수 있나요"),
                ("partial", "실거주 갱신 거절 조건"),
                ("partial", "전월세 5% 상한제"),
                ("edge", "계약갱신청구권거절 조건"),
            ]

        # index 32: 전세사기 피해
        elif idx == 32:
            entry_queries = [
                ("exact", "전세사기 피해"),
                ("exact", "전세사기 유형 빌라"),
                ("natural", "전세사기 당했을 때 어떻게 해야 하나요"),
                ("natural", "깡통전세란 무엇인가요"),
                ("partial", "전세보증보험 가입 방법"),
                ("partial", "전세사기피해지원법 혜택"),
                ("edge", "전세사기피해 대처"),
            ]

        # index 33: 이혼 재산분할
        elif idx == 33:
            entry_queries = [
                ("exact", "이혼 재산분할"),
                ("exact", "이혼 재산분할 비율"),
                ("natural", "이혼 시 재산을 어떻게 나누나요"),
                ("natural", "전업주부 재산분할 기여도"),
                ("partial", "민법 839조 재산분할"),
                ("partial", "퇴직금 재산분할 대상"),
                ("edge", "이혼재산분할 비율"),
            ]

        # index 34: 양육비 청구
        elif idx == 34:
            entry_queries = [
                ("exact", "양육비 청구"),
                ("exact", "양육비 불이행 강제집행"),
                ("natural", "전 배우자가 양육비 안 주면 어떻게 하나요"),
                ("natural", "양육비이행관리원에서 도움받을 수 있나요"),
                ("partial", "직접지급명령 양육비"),
                ("partial", "양육비 감치 운전면허"),
                ("edge", "양육비청구 강제집행"),
            ]

        # index 35: 사실혼 법적 권리
        elif idx == 35:
            entry_queries = [
                ("exact", "사실혼 법적 권리"),
                ("exact", "사실혼 재산분할"),
                ("natural", "사실혼 관계에서 헤어지면 재산 분할이 되나요"),
                ("natural", "혼인신고 안 하고 같이 살면 법적 보호받나요"),
                ("partial", "사실혼 상속권 인정"),
                ("partial", "사실혼 위자료 청구"),
                ("edge", "사실혼 법적보호 권리"),
            ]

        # index 36: 친권 양육권
        elif idx == 36:
            entry_queries = [
                ("exact", "친권 양육권"),
                ("exact", "양육권 변경 판례"),
                ("natural", "이혼 후 아이 양육권은 어떻게 결정되나요"),
                ("natural", "친권과 양육권의 차이가 뭔가요"),
                ("partial", "아동학대 친권 제한"),
                ("partial", "가정법원 양육권 심판"),
                ("edge", "친권양육권 판례"),
            ]

        # index 37: 스토킹처벌법
        elif idx == 37:
            entry_queries = [
                ("exact", "스토킹처벌법"),
                ("exact", "스토킹 신고 처벌 형량"),
                ("natural", "스토킹 당했을 때 어떻게 신고하나요"),
                ("natural", "전 연인이 계속 연락하면 스토킹인가요"),
                ("partial", "스토킹 접근금지 신청"),
                ("partial", "2021 스토킹처벌법 시행"),
                ("edge", "스토킹처벌법 신고"),
            ]

        # index 38: 성범죄 처벌 / 딥페이크
        elif idx == 38:
            entry_queries = [
                ("exact", "성범죄 처벌 강화"),
                ("exact", "딥페이크 성범죄"),
                ("natural", "딥페이크 성범죄 처벌은 얼마나 되나요"),
                ("natural", "불법 촬영 사진 유포되면 어떻게 신고하나요"),
                ("partial", "디지털성범죄피해지원센터"),
                ("partial", "N번방 성착취물 처벌"),
                ("edge", "딥페이크성범죄 처벌"),
            ]

        # index 39: 보이스피싱 피해
        elif idx == 39:
            entry_queries = [
                ("exact", "보이스피싱 피해"),
                ("exact", "보이스피싱 대처 신고"),
                ("natural", "보이스피싱 당했을 때 어떻게 해야 하나요"),
                ("natural", "계좌 지급정지 신청 방법"),
                ("partial", "금융감독원 1332 피해신고"),
                ("partial", "통신사기피해환급법 신청"),
                ("edge", "보이스피싱피해 대처"),
            ]

        # index 40: 가정폭력 법적 대응
        elif idx == 40:
            entry_queries = [
                ("exact", "가정폭력 법적 대응"),
                ("exact", "가정폭력 신고 방법"),
                ("natural", "가정폭력 당하면 어디에 신고하나요"),
                ("natural", "가정폭력 피해자 보호 방법"),
                ("partial", "여성긴급전화 1366 가정폭력"),
                ("partial", "접근금지 보호명령 신청"),
                ("edge", "가정폭력신고 법적대응"),
            ]

        # index 41: 개인정보보호법 개정 2023
        elif idx == 41:
            entry_queries = [
                ("exact", "개인정보 개정"),
                ("exact", "개인정보보호법 2023"),
                ("natural", "2023년 개인정보 보호법 바뀐 내용"),
                ("natural", "개인정보 이동권이란 무엇인가요"),
                ("partial", "자동화 결정 거부권 AI"),
                ("partial", "개인정보보호법 과징금 강화"),
                ("edge", "개인정보개정 이동권"),
            ]

        # index 42: 사이버범죄
        elif idx == 42:
            entry_queries = [
                ("exact", "사이버범죄"),
                ("exact", "사이버범죄 해킹 랜섬웨어"),
                ("natural", "해킹당했을 때 어디에 신고하나요"),
                ("natural", "랜섬웨어 피해 어떻게 대처하나요"),
                ("partial", "정보통신망법 해킹 처벌"),
                ("partial", "사이버수사대 신고"),
                ("edge", "사이버범죄 해킹신고"),
            ]

        # index 43: 공정거래법
        elif idx == 43:
            entry_queries = [
                ("exact", "공정거래법"),
                ("exact", "공정거래법 개정 위반"),
                ("natural", "독점 및 불공정 거래 신고 방법"),
                ("natural", "담합이란 무엇이고 어떻게 처벌받나요"),
                ("partial", "공정거래위원회 신고"),
                ("partial", "가맹본부 갑질 과징금"),
                ("edge", "공정거래법위반 신고"),
            ]

        # index 44: 온라인 쇼핑 환불
        elif idx == 44:
            entry_queries = [
                ("exact", "온라인 쇼핑 환불"),
                ("exact", "전자상거래 청약철회"),
                ("natural", "온라인에서 산 물건 환불 가능한가요"),
                ("natural", "청약철회 기간이 얼마나 되나요"),
                ("partial", "7일 이내 청약철회 권리"),
                ("partial", "구독서비스 해지 방법"),
                ("edge", "온라인쇼핑환불 청약철회"),
            ]

        # index 45: 부동산 세금
        elif idx == 45:
            entry_queries = [
                ("exact", "부동산 세금"),
                ("exact", "취득세 양도소득세 종합부동산세"),
                ("natural", "집 사면 어떤 세금을 내야 하나요"),
                ("natural", "양도소득세 비과세 조건"),
                ("partial", "취득세 세율 주택"),
                ("partial", "종부세 12억 공시가격"),
                ("edge", "부동산세금 종류"),
            ]

        # index 46: 상속세 증여세
        elif idx == 46:
            entry_queries = [
                ("exact", "상속세 증여세"),
                ("exact", "상속세 계산 증여세 기준"),
                ("natural", "부모님 재산 상속받으면 세금이 얼마나 되나요"),
                ("natural", "자녀에게 증여하면 세금이 얼마 발생하나요"),
                ("partial", "증여세 5000만원 공제"),
                ("partial", "상속세율 50% 최고세율"),
                ("edge", "상속세증여세 계산"),
            ]

        # index 47: 행정심판 방법
        elif idx == 47:
            entry_queries = [
                ("exact", "행정심판 방법"),
                ("exact", "행정심판 절차 신청"),
                ("natural", "행정기관 처분에 불복하려면 어떻게 하나요"),
                ("natural", "행정심판과 행정소송의 차이"),
                ("partial", "행정심판 90일 청구 기간"),
                ("partial", "중앙행정심판위원회 신청"),
                ("edge", "행정심판방법 신청"),
            ]

        # index 48: 헌법재판소 결정
        elif idx == 48:
            entry_queries = [
                ("exact", "헌법재판소 결정"),
                ("exact", "위헌 헌법불합치"),
                ("natural", "헌법재판소에 헌법소원 하는 방법"),
                ("natural", "위헌과 헌법불합치의 차이가 뭔가요"),
                ("partial", "간통죄 위헌 결정"),
                ("partial", "헌법소원 청구 기한"),
                ("edge", "헌법재판소결정 위헌"),
            ]

        # index 49: 가처분 신청
        elif idx == 49:
            entry_queries = [
                ("exact", "가처분 신청"),
                ("exact", "가처분 방법 임시조치"),
                ("natural", "가처분 신청은 어떻게 하나요"),
                ("natural", "가압류와 가처분의 차이"),
                ("partial", "처분금지가처분 부동산"),
                ("partial", "해고효력정지가처분"),
                ("edge", "가처분신청 방법"),
            ]

        # index 50: 소액사건 소송
        elif idx == 50:
            entry_queries = [
                ("exact", "소액사건 소송"),
                ("exact", "소액사건 심판 3000만원"),
                ("natural", "소액으로 소송하는 방법"),
                ("natural", "소액사건심판이란 무엇인가요"),
                ("partial", "전자소송 소액심판 신청"),
                ("partial", "지급명령 소액심판 비교"),
                ("edge", "소액사건소송 방법"),
            ]

        # index 51: 조정 중재 ADR
        elif idx == 51:
            entry_queries = [
                ("exact", "조정 중재"),
                ("exact", "분쟁 해결 ADR"),
                ("natural", "소송 안 하고 분쟁 해결하는 방법"),
                ("natural", "법원 민사조정이란 무엇인가요"),
                ("partial", "금융분쟁조정 금감원"),
                ("partial", "노동위원회 조정 신청"),
                ("edge", "조정중재 ADR신청"),
            ]

        # index 52: 재건축 재개발 권리
        elif idx == 52:
            entry_queries = [
                ("exact", "재건축 권리"),
                ("exact", "재개발 조합원 입주권"),
                ("natural", "재건축 조합원이 되면 어떤 권리가 있나요"),
                ("natural", "재개발 세입자 주거이전비"),
                ("partial", "조합원 분담금 이주비"),
                ("partial", "매도청구권 재건축"),
                ("edge", "재건축권리 조합원"),
            ]

        # index 53: 정리해고 요건
        elif idx == 53:
            entry_queries = [
                ("exact", "정리해고 요건"),
                ("exact", "정리해고 절차 경영상 해고"),
                ("natural", "회사 경영상 이유로 해고당했는데 정당한가요"),
                ("natural", "정리해고 4요건이 뭔가요"),
                ("partial", "긴박한 경영상 필요성"),
                ("partial", "근로기준법 24조 경영상 해고"),
                ("edge", "정리해고요건 경영상"),
            ]

        # index 54: 퇴직금 미지급
        elif idx == 54:
            entry_queries = [
                ("exact", "퇴직금 미지급"),
                ("exact", "퇴직금 못 받을 때"),
                ("natural", "퇴직했는데 퇴직금을 안 줘요 어떻게 하나요"),
                ("natural", "퇴직금 계산법이 어떻게 되나요"),
                ("partial", "고용노동부 퇴직금 진정"),
                ("partial", "체당금 제도 도산"),
                ("edge", "퇴직금미지급 대응"),
            ]

        # index 55: 비정규직 차별
        elif idx == 55:
            entry_queries = [
                ("exact", "비정규직 차별"),
                ("exact", "기간제 파견 차별 시정"),
                ("natural", "비정규직이라고 차별받는데 어떻게 하나요"),
                ("natural", "계약직 정규직 임금 차별 시정 방법"),
                ("partial", "노동위원회 차별시정 신청"),
                ("partial", "기간제법 파견법 차별"),
                ("edge", "비정규직차별 시정"),
            ]

        # index 56: 저작권 침해
        elif idx == 56:
            entry_queries = [
                ("exact", "저작권 침해 신고"),
                ("exact", "저작권 위반 판례"),
                ("natural", "내 사진이나 글 무단으로 사용되면 어떻게 하나요"),
                ("natural", "저작권 침해 어디에 신고하나요"),
                ("partial", "한국저작권보호원 신고"),
                ("partial", "AI 생성물 저작권"),
                ("edge", "저작권침해신고 방법"),
            ]

        # index 57: 영업비밀 침해
        elif idx == 57:
            entry_queries = [
                ("exact", "영업비밀 침해"),
                ("exact", "경업금지 퇴사 대처"),
                ("natural", "전 직장 영업비밀 가져가면 처벌받나요"),
                ("natural", "경업금지 약정이 유효한 조건"),
                ("partial", "부정경쟁방지법 영업비밀"),
                ("partial", "영업비밀 해외 유출 처벌"),
                ("edge", "영업비밀침해 경업금지"),
            ]

        # index 58: 불법 대출 피해
        elif idx == 58:
            entry_queries = [
                ("exact", "불법 대출 피해"),
                ("exact", "대부업 추심 고금리"),
                ("natural", "불법 대부업체에서 고금리 대출 피해 당했어요"),
                ("natural", "불법 추심 협박 어떻게 신고하나요"),
                ("partial", "법정 최고금리 20% 초과"),
                ("partial", "채권추심법 위반 신고"),
                ("edge", "불법대출피해 추심"),
            ]

        # index 59: 의료사고 소송
        elif idx == 59:
            entry_queries = [
                ("exact", "의료사고 소송"),
                ("exact", "의료사고 과실 분쟁"),
                ("natural", "의료사고 피해 어디에 신고하나요"),
                ("natural", "수술 잘못됐는데 병원 상대로 소송하는 방법"),
                ("partial", "의료분쟁조정중재원 1670"),
                ("partial", "의료과실 입증 책임"),
                ("edge", "의료사고소송 방법"),
            ]

        # index 60: 층간소음 대응
        elif idx == 60:
            entry_queries = [
                ("exact", "층간소음 대응"),
                ("exact", "층간소음 법적 소송"),
                ("natural", "윗집 층간소음 심한데 어떻게 해야 하나요"),
                ("natural", "층간소음 신고 방법"),
                ("partial", "층간소음이웃사이센터 1661"),
                ("partial", "환경분쟁조정위원회 소음"),
                ("edge", "층간소음대응 법적"),
            ]

        # index 61: 공증 방법
        elif idx == 61:
            entry_queries = [
                ("exact", "공증 방법"),
                ("exact", "공정증서 절차"),
                ("natural", "공증을 받으려면 어떻게 하나요"),
                ("natural", "공정증서와 내용증명의 차이"),
                ("partial", "집행력 있는 공정증서"),
                ("partial", "공증 수수료 비용"),
                ("edge", "공증방법 공정증서"),
            ]

        # index 62: 전세사기 지원 (전세사기피해지원법)
        elif idx == 62:
            entry_queries = [
                ("exact", "전세사기 지원"),
                ("exact", "전세사기피해지원법"),
                ("natural", "전세사기 피해자 지원 혜택이 뭔가요"),
                ("natural", "전세사기피해지원법 신청 방법"),
                ("partial", "우선매수권 경매 전세피해"),
                ("partial", "저금리 대환대출 전세사기"),
                ("edge", "전세사기지원 피해지원법"),
            ]

        # index 63: 중고거래 사기
        elif idx == 63:
            entry_queries = [
                ("exact", "중고거래 사기"),
                ("exact", "당근마켓 중고나라 신고"),
                ("natural", "중고거래에서 사기 당했을 때 어떻게 하나요"),
                ("natural", "당근마켓 사기 신고 방법"),
                ("partial", "사이버수사대 중고사기 신고"),
                ("partial", "계좌 지급정지 중고거래"),
                ("edge", "중고거래사기 신고"),
            ]

        # index 64: 가상자산 사기
        elif idx == 64:
            entry_queries = [
                ("exact", "가상자산 사기"),
                ("exact", "코인 투자 사기 가상화폐"),
                ("natural", "코인 투자 사기 당했는데 신고할 수 있나요"),
                ("natural", "가상화폐 사기 어떻게 처벌받나요"),
                ("partial", "특금법 가상자산 FIU"),
                ("partial", "가상자산이용자보호법 시세조종"),
                ("edge", "가상자산사기 신고"),
            ]

        else:
            # 폴백: 기본 쿼리 생성
            entry_queries = [
                ("exact", first_kw),
                ("natural", f"{first_kw} 어떻게 하나요"),
                ("partial", ' '.join(q_parts[:3]) if len(q_parts) >= 3 else first_kw),
                ("edge", first_kw.replace(' ', '')),
            ]

        all_queries.append((idx, entry_queries))

    return all_queries


# ── 테스트 실행 ────────────────────────────────────────────────────
THRESHOLD_OP = 0.15   # 운영 임계값
THRESHOLD_QUAL = 0.80  # 품질 임계값

print("=" * 70)
print("법률 KB 정확도 테스트 시작")
print(f"운영 임계값: {THRESHOLD_OP} | 품질 임계값: {THRESHOLD_QUAL}")
print("=" * 70)

all_query_groups = make_queries(entries)

results_per_entry = []  # (entry_idx, pass_count, total_count, failures)

total_queries = 0
total_pass = 0

for entry_idx, query_list in all_query_groups:
    entry = entries[entry_idx]
    entry_q = entry['q']
    # 정답 확인: 검색 결과의 첫 번째 q가 entry_q와 일치해야 함
    correct_q = entry_q

    pass_count = 0
    failures = []

    for label, query in query_list:
        results = engine.search(query, n=3, min_score=0.0)

        if results:
            top_q, top_a, top_score, top_meta = results[0]
            is_correct = (top_q == correct_q)
            above_threshold = top_score >= THRESHOLD_OP
            hit = is_correct and above_threshold
        else:
            top_q = "(결과 없음)"
            top_score = 0.0
            is_correct = False
            above_threshold = False
            hit = False

        total_queries += 1
        if hit:
            pass_count += 1
            total_pass += 1
        else:
            failures.append({
                'label': label,
                'query': query,
                'got_q': top_q[:80] if top_q else '',
                'got_score': top_score,
                'is_correct': is_correct,
                'above_threshold': above_threshold,
            })

    results_per_entry.append((entry_idx, pass_count, len(query_list), failures))


# ── 결과 출력 ─────────────────────────────────────────────────────
print("\n" + "=" * 70)
print("항목별 정확도 결과")
print("=" * 70)

green_count = 0  # ≥80%
yellow_count = 0  # 60~79%
red_count = 0    # <60%

for entry_idx, pass_count, total_count, failures in results_per_entry:
    entry = entries[entry_idx]
    pct = pass_count / total_count * 100

    # 항목 제목 추출 (q 필드 첫 15자)
    q_preview = entry['q'].split()[0:4]
    title = ' '.join(q_preview)[:40]

    if pct >= 80:
        status = "✅"
        green_count += 1
    elif pct >= 60:
        status = "⚠️"
        yellow_count += 1
    else:
        status = "❌"
        red_count += 1

    print(f"{status} [{entry_idx:2d}] {title:<42} {pass_count}/{total_count} ({pct:.0f}%)")

# ── 실패 쿼리 상세 출력 ───────────────────────────────────────────
print("\n" + "=" * 70)
print("실패 쿼리 상세 (정확도 <100% 항목)")
print("=" * 70)

for entry_idx, pass_count, total_count, failures in results_per_entry:
    if not failures:
        continue
    entry = entries[entry_idx]
    pct = pass_count / total_count * 100
    q_preview = ' '.join(entry['q'].split()[:4])[:40]

    print(f"\n[{entry_idx}] {q_preview} ({pass_count}/{total_count}, {pct:.0f}%)")
    for f in failures:
        reason = ""
        if not f['is_correct']:
            reason = f"→ 잘못된 항목 반환 (score={f['got_score']:.3f})"
        elif not f['above_threshold']:
            reason = f"→ 점수 미달 (score={f['got_score']:.3f} < {THRESHOLD_OP})"

        print(f"  [{f['label']:8s}] '{f['query']}'")
        print(f"           {reason}")
        print(f"           반환: '{f['got_q'][:70]}'")


# ── 전체 요약 ─────────────────────────────────────────────────────
print("\n" + "=" * 70)
print("전체 요약 통계")
print("=" * 70)
overall_pct = total_pass / total_queries * 100 if total_queries else 0
print(f"총 쿼리 수: {total_queries}")
print(f"전체 정확도: {total_pass}/{total_queries} ({overall_pct:.1f}%)")
print(f"✅ 80% 이상: {green_count}개 항목")
print(f"⚠️  60~79%: {yellow_count}개 항목")
print(f"❌ 60% 미만: {red_count}개 항목")
print(f"대상 임계값(≥{THRESHOLD_OP})에서 측정")


# ── q-field 수정 제안 ─────────────────────────────────────────────
print("\n" + "=" * 70)
print("q-field 수정이 필요한 항목 (정확도 <80%)")
print("=" * 70)

needs_fix = [(idx, pc, tc, fl) for idx, pc, tc, fl in results_per_entry
             if pc / tc < 0.80]

if not needs_fix:
    print("모든 항목이 80% 이상 정확도를 달성했습니다!")
else:
    for entry_idx, pass_count, total_count, failures in needs_fix:
        entry = entries[entry_idx]
        pct = pass_count / total_count * 100
        q_preview = entry['q'][:80]
        print(f"\n항목 [{entry_idx}] (정확도 {pct:.0f}%)")
        print(f"  현재 q: '{q_preview}...'")

        # 어떤 쿼리가 실패했는지 분석
        failed_queries = [f['query'] for f in failures]
        print(f"  실패 쿼리: {failed_queries}")

        # 구체적 수정 제안
        natural_fails = [f for f in failures if f['label'] == 'natural']
        if natural_fails:
            missing_kws = set()
            for f in natural_fails:
                words = f['query'].split()
                for w in words:
                    if len(w) >= 2 and w not in entry['q']:
                        missing_kws.add(w)
            if missing_kws:
                kw_str = ' '.join(list(missing_kws)[:5])
                print(f"  제안: q 필드에 자연어 변형 키워드 추가 → '{kw_str}'")
