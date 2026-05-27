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
}

def _tok(text: str) -> List[str]:
    text = re.sub(r'[^\w가-힣a-zA-Z0-9\s]', ' ', text)
    return [w.lower() for w in text.split() if len(w) >= 2 and w not in _STOP]

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

    def add(self, q: str, a: str, meta: dict = None):
        self._qa.append((q, a, meta or {}))
        self._dirty = True

    def count(self) -> int:
        return len(self._qa)

    def _build(self):
        N = len(self._qa)
        if N == 0:
            self._dirty = False
            return

        # 질문 + 답변 앞부분으로 인덱스
        all_f = [_feat(q + ' ' + a[:300]) for q, a, _ in self._qa]

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

    def search(self, query: str, n: int = 4, persona: str = None,
               min_score: float = 0.07) -> List[Tuple[str, str, float, dict]]:
        if self._dirty:
            self._build()
        if not self._qa:
            return []

        qv = self._qvec(query)
        results = []
        for i, (q, a, meta) in enumerate(self._qa):
            p = meta.get('persona', '')
            if persona and p and p != persona:
                continue
            s = self._cos(qv, self._vecs[i])
            if s >= min_score:
                results.append((q, a, s, meta))

        results.sort(key=lambda x: x[2], reverse=True)
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
        print(f"✅ 자체 AI 엔진 초기화 완료: {_engine.count()}개 지식 항목 로드")
    except Exception as e:
        print(f"⚠️ 지식베이스 로드 실패: {e}")


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
    prefix = _PERSONA_PREFIX.get(persona, '')
    ctx = context.strip()
    # 너무 길면 자름
    if len(ctx) > 3000:
        ctx = ctx[:3000] + "\n\n...(내용 일부 생략)"

    return (
        f"{prefix}"
        f"**검색 결과를 바탕으로 답변드립니다.**\n\n"
        f"{ctx}\n\n"
        f"---\n"
        f"💡 위 내용은 실시간 검색 결과입니다. 더 자세한 내용이 필요하시면 추가 질문해 주세요."
    )


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

        results = engine.search(search_q, n=4, persona=persona)
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
