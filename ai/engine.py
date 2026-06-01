"""
자체 AI 엔진 — 외부 API 완전 불필요
순수 Python TF-IDF 기반 한국어 지식 검색 + 응답 생성
"""

import re
import math
import asyncio
from collections import Counter, defaultdict
from typing import AsyncGenerator, List, Tuple, Dict

# ── 1. 한국어 토크나이저 ──────────────────────────────

_STOP = {
    '이','그','저','것','수','있','하','되','않','같','때','또','더',
    '및','등','를','을','은','는','가','의','에','서','로','으로',
    '와','과','도','만','까지','부터','에서','에게','한테','합니다',
    '습니다','입니다','됩니다','하세요','해요','어요','아요','이에요',
    '인가요','인지요','을까요','ㄹ까요','해주세요','주세요','어떻게',
    '무엇','뭐가','뭔가','어떤','어느','언제','왜','얼마','어디',
    # 의도어 (질문 의도를 나타내지만 내용과 무관한 단어)
    '설명','설명해','설명해줘','알려줘','알려','관련','대해','대한',
    '대해서','뭐야','뭔지','궁금해','알고싶어','뭔가요','궁금합니다',
    '알려주세요','설명해주세요','알고싶습니다',
}

# ── 법률명 별칭 매핑 ──────────────────────────────────
_LAW_NAMES = {
    '근로기준법': ['근로기준법'],
    '퇴직급여법': ['퇴직급여법', '퇴직급여보장법', '근로자퇴직급여', '퇴직급여 보장법'],
    '일가정양립법': ['일가정양립법', '남녀고용평등', '육아휴직법', '가족양립'],
    '최저임금법': ['최저임금법', '최저임금'],
    '기간제법': ['기간제법', '기간제 및 단시간', '기간제근로자'],
}

def _detect_law(text: str) -> str:
    """쿼리 또는 문서에서 법률명 감지"""
    for law_key, aliases in _LAW_NAMES.items():
        if any(alias in text for alias in aliases):
            return law_key
    return ''

# 한국어 어미 제거 — "계산해줘"→"계산", "며칠인지"→"며칠", "2026년"→"2026"
_KR_SUFFIXES = [
    '해주세요', '해줄래', '해봐줘', '해봐', '해줘',
    '하는방법', '하는법', '방법은', '이란무엇', '이란뭐',
    '인가요', '인지요', '인가', '인지',
    '이에요', '예요', '이죠', '이야', '죠', '이야',
    '하나요', '되나요', '나요', '아요', '어요',
    '해요', '하요', '하면', '이면',
    # 비교·조사 어미
    '보다', '에서는', '한테서', '이랑', '이지만',
    # 동사 과거형 어미
    '했는데', '됐는데', '았는데', '었는데',
    '했어요', '됐어요', '었어요', '았어요',
    '했을때', '됐을때', '했을',
]

# 한국어 격조사 — 단어에 붙어서 토큰을 분리하는 경우 처리
# 긴 것부터 순서대로 배치해야 정확하게 매칭됨
_KR_PARTICLES = [
    '에서는', '에게는', '으로는', '로부터', '에게서',
    '으로도', '로도', '에도', '에서', '에게', '으로', '이나', '이고',
    '이며', '이라', '이란', '이랑', '이면', '이지',
    '에는', '는데', '은데', '는요', '은요',
    '는', '은', '를', '을', '의', '도', '만', '로', '와', '과',
    '나', '고', '며', '라', '에',
]

def _strip_kr(word: str) -> str:
    """한국어 어미·조사 제거 후 어근 반환"""
    # 숫자+년/월/일 → 숫자만
    m = re.match(r'^(\d+)(년도?|월|일)$', word)
    if m:
        return m.group(1)
    # 동사 어미 먼저 처리
    for suf in _KR_SUFFIXES:
        if word.endswith(suf) and len(word) > len(suf) + 1:
            return word[:-len(suf)]
    # 격조사 처리 (어근이 2글자 이상인 경우만)
    for particle in _KR_PARTICLES:
        if word.endswith(particle) and len(word) - len(particle) >= 2:
            return word[:-len(particle)]
    return word


# 붙여쓰기 복합어 → 공백 분리 정규화
_COMPOUND_MAP = {
    '직장내괴롭힘': '직장 내 괴롭힘',
    '해고예고': '해고 예고',
    '출산전후휴가': '출산 전후 휴가',
    '출산휴가': '출산 전후 휴가',
    '육아휴직급여': '육아휴직 급여',
    '임금체불': '임금 체불',
    '퇴직금계산': '퇴직금 계산',
    '연말정산방법': '연말정산 방법',
    '근로계약서작성': '근로계약서 작성',
    '산재처리': '산재 처리',
    '재택근무': '재택 근무',
    '파이썬기초': '파이썬 기초',
    '리액트훅': 'React 훅',
    '클린코드': '클린 코드',
    '수습기간': '수습 기간',
    '여행보험': '여행자 보험',
    '여행자보험': '여행자 보험',
    '두바이여행': '두바이 여행',
    '두바이코스': '두바이 코스',
    '산재신청': '산재 신청',
    '임금체불신고': '임금 체불 신고',
    '도쿄여행': '도쿄 여행',
    '유럽배낭여행': '유럽 배낭여행',
    '유럽배낭': '유럽 배낭여행',
    '해고예고수당': '해고 예고수당',
    # 법률 자연어 표현 정규화
    '계약갱신요청': '계약갱신청구권 거절',
    '계약갱신거절': '계약갱신청구권 거절',
    '스토킹당했': '스토킹 신고',
    '스토킹피해': '스토킹 피해',
    '전세사기당했': '전세사기 피해',
    '보이스피싱당했': '보이스피싱 피해',
    '사기당했': '사기죄 피해',
    # 사내규정 복합어
    '시차출퇴근제': '시차 출퇴근제',
    '출장일비': '출장 일비',
    '고충처리위원회': '고충처리 위원회',
    '고충처리위원': '고충처리 위원',
    '노사협의회': '노사 협의회',
    '선거관리위원회': '선거관리 위원회',
    '임원퇴직급여': '임원 퇴직급여',
    '임원상여금': '임원 상여금',
    '복지카드포인트': '복지카드 포인트',
    '장기근속자': '장기근속 자',
    '사내대출': '사내 대출',
    '건강검진비': '건강검진 비용',
    '가족돌봄휴가': '가족돌봄 휴가',
    '자녀돌봄': '자녀 돌봄',
    '연차휴가': '연차 휴가',
    '대체휴가': '대체 휴가',
    '경조휴가': '경조 휴가',
    '경조금': '경조 금',
    '건강수당': '건강 수당',
    '학위취득': '학위 취득',
    '교육비지원': '교육비 지원',
    '인재추천': '인재 추천',
    '사내행사': '사내 행사',
    '노트북관리': '노트북 관리',
    '소프트웨어관리': '소프트웨어 관리',
    '장기근속포상': '장기근속 포상',
    '우수직원포상': '우수직원 포상',
    '우수직원': '우수 직원',
    '사원증재발급': '사원증 재발급',
    '명함신청': '명함 신청',
    '복장규정': '복장 규정',
    '천안사무실': '천안 사무실',
    '전사공통휴무': '전사 공통 휴무',
    '자녀출산': '자녀 출산',
    '임원관리규정': '임원 관리 규정',
    '해외출장규정': '해외출장 규정',
    '경비규정': '경비 규정',
    '주근무지': '주 근무지',
    '휴일근무': '휴일 근무',
    '야근식대': '야근 식대',
    '비밀유지': '비밀 유지',
    '조의금': '경조 금',
    '프로젝트': 'PJT',
    '회식비': '회식 비용',
    '유연근무제': '시차 출퇴근제',
    '밥값': '식대',
    '근로자위원': '근로자 위원',
    '고충처리': '고충 처리',
}


def _normalize_compound(text: str) -> str:
    for compound, expanded in _COMPOUND_MAP.items():
        text = text.replace(compound, expanded)
    return text


def _tok(text: str) -> List[str]:
    text = _normalize_compound(text)
    text = re.sub(r'[^\w가-힣a-zA-Z0-9\s]', ' ', text)
    tokens = []
    for w in text.split():
        if len(w) < 2 or w in _STOP:
            continue
        w_lower = w.lower()
        # 조항 번호 정규화: "3조" → "제3조"
        if re.match(r'^\d+조$', w_lower):
            tokens.append(f'제{w_lower}')
            continue
        # 한국어 어미 제거 후 어근 추가 (원형도 함께 보존)
        root = _strip_kr(w_lower)
        if root != w_lower and len(root) >= 2 and root not in _STOP:
            tokens.append(root)   # 어근 (계산, 며칠 등)
        tokens.append(w_lower)   # 원형도 보존
    return tokens

def _feat(text: str) -> List[str]:
    t = _tok(text)
    bg = [f'{t[i]}_{t[i+1]}' for i in range(len(t) - 1)]
    return t + bg


# ── 2. TF-IDF 검색 엔진 ──────────────────────────────

class _Engine:
    def __init__(self):
        self._qa: List[Tuple[str, str, dict]] = []   # (질문텍스트, 답변, 메타)
        self._vecs: List[Dict[str, float]] = []
        self._idf: Dict[str, float] = {}
        self._dirty = True
        self._deleted: set = set()   # 소프트 삭제된 인덱스

    def add(self, q: str, a: str, meta: dict = None):
        self._qa.append((q, a, meta or {}))
        self._dirty = True

    def count(self) -> int:
        return len(self._qa) - len(self._deleted)

    def delete_by_q(self, question: str, persona: str = None):
        """동일 질문의 기존 항목을 소프트 삭제 (검색에서 제외)"""
        q_lower = question.strip().lower()
        for i, (q, a, meta) in enumerate(self._qa):
            if i in self._deleted:
                continue
            if q.strip().lower() == q_lower:
                if persona is None or meta.get("persona") == persona:
                    self._deleted.add(i)
                    self._dirty = True

    def delete_by_source(self, source: str, persona: str = None):
        """특정 소스(예: '문서:파일명')의 모든 항목 소프트 삭제"""
        for i, (q, a, meta) in enumerate(self._qa):
            if i in self._deleted:
                continue
            if meta.get("source") == source:
                if persona is None or meta.get("persona") == persona:
                    self._deleted.add(i)
        if self._deleted:
            self._dirty = True

    def _build(self):
        N = len(self._qa)
        if N == 0:
            self._dirty = False
            return

        # q 필드 5배 가중치 부스트: q 토큰을 5번 반복 → q 키워드 일치 시 점수 대폭 상승
        all_f = [_feat(' '.join([q]*5) + ' ' + a[:200]) for q, a, _ in self._qa]

        # IDF
        df: Dict[str, int] = defaultdict(int)
        for fs in all_f:
            for f in set(fs):
                df[f] += 1
        self._idf = {f: math.log((N + 1) / (c + 1)) + 1 for f, c in df.items()}

        # TF-IDF 벡터
        self._vecs = []
        for fs in all_f:
            tf = Counter(fs)
            tot = max(len(fs), 1)
            self._vecs.append({
                f: (cnt / tot) * self._idf.get(f, 1.0)
                for f, cnt in tf.items()
            })
        self._dirty = False

    def _qvec(self, text: str) -> Dict[str, float]:
        fs = _feat(text)
        tf = Counter(fs)
        tot = max(len(fs), 1)
        return {f: (cnt / tot) * self._idf.get(f, 1.0) for f, cnt in tf.items()}

    @staticmethod
    def _cos(v1: Dict, v2: Dict) -> float:
        common = set(v1) & set(v2)
        if not common:
            return 0.0
        dot = sum(v1[k] * v2[k] for k in common)
        n1 = math.sqrt(sum(x * x for x in v1.values())) or 1e-9
        n2 = math.sqrt(sum(x * x for x in v2.values())) or 1e-9
        return dot / (n1 * n2)

    def search(self, query: str, n: int = 3, persona: str = None,
               min_score: float = 0.10) -> List[Tuple[str, str, float, dict]]:
        if self._dirty:
            self._build()
        if not self._qa:
            return []

        # 조항 번호 + 법률명 추출
        article_nums = re.findall(r'제?(\d+)조', query)
        query_law = _detect_law(query)  # 쿼리에서 법률명 감지

        qv = self._qvec(query)
        query_lower = query.lower()
        results = []
        for i, (q, a, meta) in enumerate(self._qa):
            if i in self._deleted:
                continue
            p = meta.get('persona', '')
            if persona and p and p != persona:
                continue
            s = self._cos(qv, self._vecs[i])

            if article_nums:
                qa_text = q + ' ' + a[:300]
                article_matched = any(
                    re.search(rf'(제{num}조|(?<![0-9]){num}조)', qa_text) for num in article_nums
                )
                if query_law:
                    # 법률명까지 지정된 경우: 법률 + 조항 모두 일치해야 부스트
                    # q(제목)만으로 법률명 판정 — 답변 내 다른 법 언급에 오염되지 않도록
                    doc_law = _detect_law(q)
                    law_matched = (doc_law == query_law)
                    if article_matched and law_matched:
                        s *= 3.0   # 법률 + 조항 완전 일치
                    elif article_matched and not law_matched:
                        s *= 0.1   # 조항은 맞지만 다른 법률 → 강하게 감산
                    else:
                        s *= 0.2   # 조항 불일치
                else:
                    # 법률명 없이 조항만 지정
                    s *= 2.5 if article_matched else 0.3

            else:
                q_lower = q.lower()
                exact_tokens = [t for t in _tok(query_lower) if len(t) >= 3 and t in q_lower]
                if exact_tokens:
                    match_ratio = len(exact_tokens) / max(len(_tok(query_lower)), 1)
                    s = s * (1.0 + 0.5 * match_ratio)

            if s >= min_score:
                results.append((q, a, s, meta))

        results.sort(key=lambda x: x[2], reverse=True)

        # 1위가 압도적으로 높으면 1개만 반환 (확신도 높음)
        if len(results) >= 2 and results[0][2] - results[1][2] > 0.20:
            return results[:1]

        return results[:n]


# ── 3. 글로벌 엔진 싱글턴 ────────────────────────────

_engine = _Engine()
_kb_loaded = False


def get_engine() -> _Engine:
    global _kb_loaded
    if not _kb_loaded:
        _load_knowledge()
        _kb_loaded = True
    return _engine


def _load_knowledge():
    try:
        from knowledge_base import KNOWLEDGE
        for item in KNOWLEDGE:
            _engine.add(item['q'], item['a'], {'persona': item.get('persona', '')})
    except Exception as e:
        print(f"⚠️ 지식베이스 로드 실패: {e}")

    # law.go.kr 원문 캐시 (fetch_laws.py 또는 GitHub Actions가 생성)
    try:
        import json as _json, os as _os
        cache_path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "law_data_cache.json")
        if _os.path.exists(cache_path) and _os.path.getsize(cache_path) > 10:
            with open(cache_path, encoding="utf-8") as f:
                cached = _json.load(f)
            for item in cached:
                _engine.add(item['q'], item['a'],
                            {'persona': item.get('persona', 'hr'), 'source': 'law.go.kr'})
            print(f"  📚 law.go.kr 원문 캐시: {len(cached)}개 조문")
    except Exception as e:
        print(f"⚠️ law.go.kr 캐시 로드 실패: {e}")

    # 자동학습·직접입력·문서 업로드 등 동적 학습 데이터 복원 (재시작 후에도 유지)
    # "정적KB" 소스는 Python KB 파일에서 이미 로드되었으므로 건너뜀 (중복 방지)
    try:
        import sqlite3, os as _os
        _here = _os.path.dirname(_os.path.abspath(__file__))
        db_path = _os.getenv("DB_PATH", _os.path.join(_here, "data", "memory.db"))
        if _os.path.exists(db_path):
            conn = sqlite3.connect(db_path)
            rows = conn.execute(
                "SELECT id, content, persona, source FROM learned_knowledge"
                " WHERE source != '정적KB' ORDER BY id ASC"
            ).fetchall()
            conn.close()

            # Q&A 형식 항목은 같은 질문이 여러 개면 최신(id 큰 것)만 사용
            # source가 직접입력·자동학습인 경우만 중복 제거; 문서 청크는 모두 포함
            DEDUP_SOURCES = ("직접입력", "자동학습")
            qa_latest: dict = {}   # (q_lower, persona) → (content, source)
            chunks = []            # 문서 청크 등 비-QA 항목

            for row_id, content, persona, source in rows:
                is_qa = content.startswith("Q: ") and "\nA: " in content
                if is_qa and source in DEDUP_SOURCES:
                    q_lower = content.split("\nA: ", 1)[0][3:].strip().lower()
                    qa_latest[(q_lower, persona)] = (content, source)  # 최신이 덮어씀
                else:
                    chunks.append((content, persona, source))

            # 중복 제거된 Q&A 항목 로드
            for (q_lower, persona), (content, source) in qa_latest.items():
                parts = content.split("\nA: ", 1)
                q = parts[0][3:].strip()
                a = parts[1].strip()
                _engine.add(q, a, {"persona": persona, "source": source})

            # 문서 청크 등 나머지 항목 로드
            for content, persona, source in chunks:
                if content.startswith("Q: ") and "\nA: " in content:
                    parts = content.split("\nA: ", 1)
                    q = parts[0][3:].strip()
                    a = parts[1].strip()
                else:
                    q = content[:200]
                    a = content
                _engine.add(q, a, {"persona": persona, "source": source})
    except Exception as e:
        print(f"⚠️ 동적 학습 데이터 복원 실패: {e}")

    print(f"✅ 자체 AI 엔진 초기화 완료: {_engine.count()}개 지식 항목 로드")


def teach(text: str, persona: str = '', source: str = 'learned'):
    """외부에서 학습시킬 내용을 엔진에 추가 (문서 업로드, 대화 학습)"""
    _engine.add(text[:500], text, {'persona': persona, 'source': source})


# ── 4. 페르소나 감지 ──────────────────────────────────

def detect_persona(system_prompt: str) -> str:
    if not system_prompt:
        return ''
    sp = system_prompt.lower()
    if any(k in sp for k in ['인사', 'hr', '노동', '채용', '급여', '근로']):
        return 'hr'
    if any(k in sp for k in ['개발자', '코드', '프로그래', 'python', '알고리즘']):
        return 'dev'
    if any(k in sp for k in ['여행', '항공', '숙박', '관광']):
        return 'travel'
    return ''


# ── 5. 특수 패턴 처리 ─────────────────────────────────

_GREET_PATTERN = re.compile(r'^(안녕|hello|hi|반가|처음)\s*[!.?]*$', re.I)
_THANKS_PATTERN = re.compile(r'(감사|고마|thank)', re.I)
_CAPABILITY_PATTERN = re.compile(r'(뭐|무엇|어떤).*(할 수|도움|기능|알고)')

_PERSONA_INTRO = {
    'hr': (
        "안녕하세요! 저는 경력 15년의 **인사(HR) 전문가** AI입니다. 👔\n\n"
        "다음 내용에 대해 전문적인 답변을 드릴 수 있습니다:\n"
        "- 📋 퇴직금·연차·최저임금 계산\n"
        "- 📄 근로계약서·급여명세서 작성\n"
        "- ⚖️ 노동법·4대보험·주 52시간\n"
        "- 👶 육아휴직·출산휴가\n"
        "- 🤝 채용 프로세스·연봉 협상\n\n"
        "무엇이든 편하게 질문해 주세요!"
    ),
    'dev': (
        "안녕하세요! 저는 10년 경력의 **풀스택 개발자** AI입니다. 💻\n\n"
        "다음 내용에 대해 도움드릴 수 있습니다:\n"
        "- 🐍 Python·JavaScript·TypeScript\n"
        "- ⚡ FastAPI·React·Node.js\n"
        "- 🗄️ SQL·NoSQL·Git\n"
        "- 🧩 알고리즘·디자인 패턴\n"
        "- 🐛 디버깅·코드 리뷰\n\n"
        "코드 예시를 포함해서 답변해 드립니다!"
    ),
    'travel': (
        "안녕하세요! 저는 60개국을 다닌 **여행 전문가** AI입니다. ✈️\n\n"
        "다음 내용에 대해 안내해 드릴 수 있습니다:\n"
        "- 🏝️ 국내 여행 (제주·부산·경주·강원)\n"
        "- 🌏 동남아·일본·유럽·미주 여행\n"
        "- 💰 항공권 싸게 구하기·환전 팁\n"
        "- 🏨 숙박 예약·여행 보험\n"
        "- 🎒 짐 싸기·여행 준비 체크리스트\n\n"
        "예산과 일정에 맞는 여행 계획을 세워드려요!"
    ),
    '': (
        "안녕하세요! 저는 자체 AI 어시스턴트입니다. 😊\n"
        "인사·개발·여행 페르소나를 선택하면 더 전문적인 답변을 드릴 수 있어요."
    ),
}

_THANKS_REPLY = {
    'hr': "도움이 되었다니 기쁩니다! 😊 노무 관련 추가 질문이 있으시면 언제든지 말씀해 주세요.",
    'dev': "도움이 되었다니 다행입니다! 🙌 코드 작성하다 막히면 언제든지 질문 주세요.",
    'travel': "즐거운 여행이 되길 바랍니다! ✈️ 여행 계획 중 궁금한 게 생기면 언제든지 물어보세요.",
    '': "도움이 되어서 기쁩니다! 다른 궁금한 점이 있으시면 말씀해 주세요.",
}

_NO_ANSWER = {
    'hr': (
        "정확히 일치하는 정보를 찾지 못했습니다. 😔\n\n"
        "**도움받을 수 있는 곳:**\n"
        "- 고용노동부 고객상담센터: **1350** (무료)\n"
        "- 노동OK: https://www.nodong.or.kr\n\n"
        "아래 주제라면 바로 답변 드릴 수 있어요:\n"
        "- 퇴직금 계산, 연차 일수, 최저임금\n"
        "- 4대보험, 육아휴직, 해고 절차\n"
        "- 근로계약서, 급여명세서"
    ),
    'dev': (
        "해당 내용에 대한 정보가 부족합니다. 🤔\n\n"
        "더 구체적으로 질문해 주시면 도움드릴 수 있어요:\n"
        "- 사용 언어/프레임워크 명시 (예: Python, FastAPI)\n"
        "- 발생한 오류 메시지\n"
        "- 원하는 기능 설명\n\n"
        "**참고 자료:** Stack Overflow, 공식 문서, GitHub"
    ),
    'travel': (
        "해당 여행 정보가 부족합니다. 🗺️\n\n"
        "이런 내용은 바로 답변 드릴 수 있어요:\n"
        "- 제주도·부산·경주 여행 코스\n"
        "- 일본·동남아·유럽 여행 팁\n"
        "- 항공권 싸게 구하는 법\n"
        "- 환전·여행보험·비자 정보"
    ),
    '': "해당 질문에 대한 정보가 부족합니다. 더 구체적으로 질문해 주시면 도움드리겠습니다.",
}


# ── 6. 응답 생성기 ────────────────────────────────────

def _compose(query: str, results: List, persona: str) -> str:
    # 특수 패턴: 인사
    if _GREET_PATTERN.search(query.strip()):
        return _PERSONA_INTRO.get(persona, _PERSONA_INTRO[''])

    # 특수 패턴: 감사
    if _THANKS_PATTERN.search(query):
        return _THANKS_REPLY.get(persona, _THANKS_REPLY[''])

    # 특수 패턴: 기능 문의
    if _CAPABILITY_PATTERN.search(query):
        return _PERSONA_INTRO.get(persona, _PERSONA_INTRO[''])

    # 검색 결과 없음
    if not results:
        return _NO_ANSWER.get(persona, _NO_ANSWER[''])

    best_q, best_a, best_score, _ = results[0]

    # 높은 신뢰도 (≥ 0.40): 저장된 답변 직접 사용
    if best_score >= 0.40:
        return best_a

    # 중간 신뢰도 (≥ 0.20): 상위 2개 조합
    if best_score >= 0.20:
        parts = [best_a]
        if len(results) > 1 and results[1][2] >= 0.15:
            second = results[1][1]
            if second != best_a:
                parts.append("\n\n---\n**추가 참고 사항:**\n" + second[:600])
        return '\n'.join(parts)

    # 낮은 신뢰도 (≥ 0.10): 참고 자료 제공
    if best_score >= 0.10:
        return (
            "정확히 일치하지는 않지만, 관련 정보를 안내해 드립니다.\n\n"
            + best_a[:700]
        )

    # 매우 낮음
    return _NO_ANSWER.get(persona, _NO_ANSWER[''])


# ── 7. 웹 검색·문서 컨텍스트 직접 응답 ──────────────────

def _compose_with_context(query: str, context: str, persona: str) -> str:
    """웹 검색 결과나 문서 RAG가 있을 때 직접 활용한 응답 생성"""
    ctx = context.strip()
    if len(ctx) > 3000:
        ctx = ctx[:3000] + "\n\n...(내용 일부 생략)"
    return ctx


# ── 8. 스트리밍 인터페이스 ──────────────────────────────

async def local_stream(
    messages: List[dict],
    context: str = '',
    system_prompt: str = None,
) -> AsyncGenerator[str, None]:
    """메인 스트리밍 함수 — llm.py에서 호출 (API 키 없을 때 폴백)"""

    engine = get_engine()

    # 마지막 사용자 메시지
    query = ''
    for m in reversed(messages):
        if m.get('role') == 'user':
            query = m['content'].strip()
            break

    if not query:
        yield "메시지를 입력해 주세요."
        return

    # 페르소나 감지
    persona = detect_persona(system_prompt)

    # 외부 컨텍스트 (웹 검색 결과, 문서 RAG)가 충분히 있으면 직접 사용
    # → TF-IDF 기존 지식과 경쟁하지 않고 무조건 우선 적용
    if context and len(context.strip()) > 100:
        response = _compose_with_context(query, context, persona)
    else:
        # 컨텍스트 없을 때: 지식베이스 TF-IDF 검색
        ctx_parts = [query]
        for m in reversed(messages[:-1]):
            if m.get('role') == 'assistant':
                ctx_parts.append(m['content'][:200])
                break
        search_q = ' '.join(ctx_parts)

        # 동적으로 추가된 내용은 엔진에 등록
        if context:
            engine.add(context[:600], context, {'persona': persona, 'source': 'context'})

        results = engine.search(search_q, persona=persona)
        response = _compose(query, results, persona)

    # 자연스러운 청크 스트리밍
    buf = ''
    for ch in response:
        buf += ch
        if ch in ('\n', '。', '!', '?') or len(buf) >= 25:
            yield buf
            buf = ''
            delay = 0.06 if ch == '\n' else 0.025
            await asyncio.sleep(delay)
    if buf:
        yield buf
