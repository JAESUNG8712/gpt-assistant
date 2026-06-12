"""
Claude API 클라이언트 — Anthropic SDK 래퍼
주식 분석 파이프라인의 AI 분석 엔진
"""

import os
import json
from typing import Any, Dict, Optional

_client = None


def _get_client():
    global _client
    if _client is None:
        try:
            import anthropic
            api_key = os.getenv("ANTHROPIC_API_KEY")
            if not api_key:
                return None
            _client = anthropic.Anthropic(api_key=api_key)
        except ImportError:
            return None
    return _client


def is_available() -> bool:
    """Claude API 사용 가능 여부"""
    return bool(os.getenv("ANTHROPIC_API_KEY"))


MODEL = "claude-opus-4-8"

# 시스템 프롬프트 (prompt caching용 — 고정 텍스트)
_SYSTEM_PROMPT = """당신은 대한민국 최고 수준의 주식 투자 분석 전문가입니다.
CFA(공인재무분석사), 증권사 리서치센터장 15년 경력의 관점으로 분석합니다.

분석 원칙:
1. 데이터 기반 객관적 분석 — 감정·추측 배제
2. 리스크 우선 사고 — 수익보다 손실 방지 우선
3. 멀티팩터 접근 — 재무·기술·수급·거시경제 종합
4. 한국 시장 특성 반영 — 외국인·기관 수급, 정책 영향, 지정학 리스크
5. 실행 가능한 조언 — 추상적 의견 지양, 구체적 가격·시점 제시

출력 형식: 한국어, 전문적이고 간결하게, 마크다운 없이 plain text"""


def analyze_stock_opinion(stock_name: str, analysis_data: Dict) -> str:
    """종목별 AI 투자의견 생성 (Claude)"""
    client = _get_client()
    if not client:
        return _fallback_opinion(analysis_data)

    intrinsic = analysis_data.get("내재가치", {})
    technical = analysis_data.get("기술적분석", {})
    supply = analysis_data.get("수급분석", {})
    macro = analysis_data.get("매크로연계", {})
    timing = analysis_data.get("매매시점", {})

    user_prompt = f"""다음 데이터를 바탕으로 {stock_name}에 대한 투자의견을 작성하세요.

[밸류에이션]
목표주가: {intrinsic.get('목표주가', 0):,}원 (현재가 {intrinsic.get('현재가', 0):,}원)
상승여력: {intrinsic.get('상승여력', 0):.1f}%
저평가판단: {intrinsic.get('저평가판단', 'N/A')}
PER: {intrinsic.get('현재PER', 0):.1f} (업종적정 {intrinsic.get('업종적정PER', 0)})
PBR: {intrinsic.get('현재PBR', 0):.2f}

[기술적분석]
추세: {technical.get('추세', 'N/A')}
RSI(14): {technical.get('RSI_14', 50):.1f}
종합신호: {technical.get('종합신호', 'N/A')}
기술신호: {', '.join(technical.get('기술신호', [])) or '없음'}

[수급]
외국인: {supply.get('외국인', {}).get('방향', 'N/A')} (강도 {supply.get('외국인', {}).get('강도점수', 0)}/100)
기관: {supply.get('기관', {}).get('방향', 'N/A')} (강도 {supply.get('기관', {}).get('강도점수', 0)}/100)
종합수급: {supply.get('종합수급신호', 'N/A')}

[매크로]
섹터영향: {macro.get('영향', 'N/A')}
매크로종합: {macro.get('종합', 'N/A')}
주요리스크: {macro.get('리스크', '없음')}

[매매시점]
종합점수: {timing.get('종합점수', 0)} (-100~+100)
판단근거: {', '.join(timing.get('근거', [])) or '없음'}

위 데이터를 종합해서 3-5문장으로 투자의견을 작성하세요.
반드시 포함: 투자의견(매수/중립/매도), 목표주가 근거, 핵심 리스크 1가지, 매매전략 요약."""

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=500,
            thinking={"type": "adaptive"},
            system=[
                {
                    "type": "text",
                    "text": _SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_prompt}],
        )
        return _extract_text(response)
    except Exception as e:
        print(f"⚠️  Claude API 오류 ({stock_name}): {e}")
        return _fallback_opinion(analysis_data)


def generate_executive_summary(
    economic_data: Dict,
    geo_data: Dict,
    analyses: Dict,
    risk_val: Dict,
    logic_val: Dict,
) -> str:
    """Claude로 종합 시황 요약 생성"""
    client = _get_client()
    if not client:
        return ""

    # 상위 3개 종목 추출
    top_stocks = sorted(
        [(k, v) for k, v in analyses.items() if "매매시점" in v],
        key=lambda x: x[1].get("매매시점", {}).get("종합점수", 0),
        reverse=True,
    )[:3]
    top_names = [f"{k}({v.get('투자의견', {}).get('의견', '?')})" for k, v in top_stocks]

    eco_summary = {
        "KOSPI": economic_data.get("지수", {}).get("KOSPI", {}).get("close", "N/A"),
        "원달러": economic_data.get("환율", {}).get("원달러(USD/KRW)", {}).get("현재", "N/A"),
        "한국금리": economic_data.get("금리", {}).get("한국기준금리", {}).get("현재", "N/A"),
        "시장심리": economic_data.get("시장심리", "N/A"),
    }
    geo_risk = geo_data.get("종합리스크지수", {}).get("종합지정학리스크", "N/A")
    portfolio_risk = risk_val.get("_포트폴리오리스크", {}).get("포트폴리오위험수준", "N/A")

    user_prompt = f"""오늘의 주식 시장 종합 시황을 작성하세요.

[거시경제]
KOSPI: {eco_summary['KOSPI']}
원달러: {eco_summary['원달러']}
한국기준금리: {eco_summary['한국금리']}%
시장심리: {eco_summary['시장심리']}

[리스크]
지정학리스크: {geo_risk}/100
포트폴리오위험수준: {portfolio_risk}

[추천종목 TOP3]
{', '.join(top_names) if top_names else '분석 중'}

위 데이터를 바탕으로:
1. 오늘 시장의 핵심 특징 (2문장)
2. 투자자가 주목해야 할 1가지 핵심 테마
3. 오늘의 투자 전략 한 줄 요약

총 5-7문장, plain text."""

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=600,
            thinking={"type": "adaptive"},
            system=[
                {
                    "type": "text",
                    "text": _SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_prompt}],
        )
        return _extract_text(response)
    except Exception as e:
        print(f"⚠️  Claude API 시황요약 오류: {e}")
        return ""


def generate_action_plan(top_picks: list, risk_val: Dict, economic_data: Dict) -> str:
    """Claude로 실행 가능한 투자 액션 플랜 생성"""
    client = _get_client()
    if not client:
        return ""

    picks_text = "\n".join(
        f"- {p.get('종목', p.get('종목명', '?'))}: 목표 {p.get('목표주가', 0):,}원, "
        f"의견 {p.get('의견', '?')}"
        for p in top_picks[:5]
    )
    market_signal = economic_data.get("종합판단", "중립")
    avg_risk = risk_val.get("_포트폴리오리스크", {}).get("평균리스크점수", 50)

    user_prompt = f"""다음 분석 결과를 기반으로 구체적인 투자 액션 플랜을 작성하세요.

[추천종목]
{picks_text}

[시장환경]
종합시장판단: {market_signal}
포트폴리오평균리스크: {avg_risk}/100

작성 형식:
■ 즉시 실행 (오늘): 구체적 매수/매도 행동 2-3개
■ 이번 주 모니터링: 주시할 지표·이벤트 2-3개
■ 리스크 관리: 손절·비중 조절 기준
■ 다음 보고서까지 보유 전략

각 항목은 2-3줄로 간결하게, plain text."""

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=700,
            thinking={"type": "adaptive"},
            system=[
                {
                    "type": "text",
                    "text": _SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_prompt}],
        )
        return _extract_text(response)
    except Exception as e:
        print(f"⚠️  Claude API 액션플랜 오류: {e}")
        return ""


def _extract_text(response) -> str:
    """응답에서 텍스트 블록만 추출 (thinking 블록 제외)"""
    texts = []
    for block in response.content:
        if block.type == "text":
            texts.append(block.text)
    return "\n".join(texts).strip()


def _fallback_opinion(analysis_data: Dict) -> str:
    """Claude 미사용 시 규칙 기반 의견"""
    timing = analysis_data.get("매매시점", {})
    score = timing.get("종합점수", 0)
    intrinsic = analysis_data.get("내재가치", {})
    upside = intrinsic.get("상승여력", 0)

    if score >= 30:
        opinion = "매수"
        strategy = "분할 매수 접근, 손절선 -8% 설정"
    elif score <= -30:
        opinion = "매도"
        strategy = "비중 축소 또는 매도 검토"
    else:
        opinion = "중립"
        strategy = "관망, 추가 신호 확인 후 판단"

    return (
        f"투자의견: {opinion} | 상승여력 {upside:.1f}% | 전략: {strategy} "
        f"(AI분석 미적용 — ANTHROPIC_API_KEY 설정 시 심층분석 활성화)"
    )
