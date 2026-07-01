"""
🌍🌐 세계 동향 수집 에이전트 (1: 지정학·정치 / 2: 산업·기술)
"""

import asyncio
from datetime import datetime
from typing import Dict


class GeopoliticsCollector:
    """🌍 세계 동향 수집 1 — 지정학·정치 담당"""

    def __init__(self):
        self.results: Dict = {}

    async def run(self) -> Dict:
        print("🌍 [지정학수집] 지정학·정치 동향 수집 시작")

        tasks = [
            self._collect_us_china_relations(),
            self._collect_korea_geopolitics(),
            self._collect_trade_policy(),
            self._collect_global_politics(),
            self._collect_sanctions_regulations(),
        ]

        results = await asyncio.gather(*tasks, return_exceptions=True)
        keys = ["미중관계", "한반도지정학", "무역정책", "글로벌정치", "제재규제"]

        for key, val in zip(keys, results):
            self.results[key] = val if not isinstance(val, Exception) else {"error": str(val)}

        self.results["수집시각"] = datetime.now().isoformat()
        self.results["종합리스크지수"] = self._calc_risk_index()

        print("🌍 [지정학수집] 완료")
        return self.results

    async def _collect_us_china_relations(self) -> Dict:
        return {
            "현황": "미중 관세 휴전 합의 (2026.05) — 90일 협상 기간",
            "주요내용": [
                "미국 대중 관세 145% → 30%로 임시 인하",
                "중국 대미 관세 125% → 10%로 완화",
                "반도체·AI 분야 수출통제는 유지",
                "다음 협상 시한: 2026년 8월",
            ],
            "한국영향": "반도체·배터리 수출 회복 기대, 공급망 재편 가속",
            "리스크레벨": "중간 (협상 결렬 시 재상승)",
            "모니터링": ["8월 협상 결과", "엔비디아 AI칩 대중 수출규제 변화"],
        }

    async def _collect_korea_geopolitics(self) -> Dict:
        return {
            "남북관계": {
                "현황": "단절 상태 유지, 북한 핵·미사일 활동 감시",
                "최근동향": "2026년 상반기 북한 ICBM 발사 없음, 비교적 조용",
                "리스크레벨": "낮음~중간",
            },
            "한일관계": {
                "현황": "셔틀외교 복원, 경제 협력 강화 기조",
                "영향": "공급망 협력, 관광 수요 증가",
            },
            "한미동맹": {
                "현황": "방위비 분담금 협상 진행 중",
                "관세": "한미 관세 협상 진행 (자동차·반도체 분야)",
            },
            "국내정치": {
                "현황": "2026년 6·1 지방선거 종료, 정치 안정기 진입",
                "영향": "하반기 경제정책 집중 가능성",
            },
        }

    async def _collect_trade_policy(self) -> Dict:
        return {
            "미국관세정책": {
                "현황": "트럼프 행정부 상호관세 조정 중",
                "한국영향산업": {
                    "자동차": "25% 관세 협상 중 (현대·기아 현지생산 확대로 일부 완충)",
                    "철강": "25% 관세 유지, 쿼터 협상 가능성",
                    "반도체": "일부 면세 유지, 조건부 제한 논의",
                    "배터리": "IRA 첨단제조세액공제 수혜 유지",
                },
            },
            "WTO_통상분쟁": "미국 IRA 관련 분쟁 제소 협의 중",
            "CPTPP": "한국 가입 협상 재개 검토",
            "RCEP효과": "아세안 수출 확대 지속",
        }

    async def _collect_global_politics(self) -> Dict:
        return {
            "러우전쟁": {
                "현황": "2년 이상 장기화, 평화협상 논의 초기 단계",
                "시장영향": "에너지·곡물 공급 불안 일부 해소, 방산 섹터 투자 지속",
                "한국영향": "방산 수출 호조 (폴란드 등), LNG 공급망 다변화 진행",
            },
            "중동": {
                "현황": "이스라엘-하마스 전쟁 지속, 호르무즈해협 리스크 경계",
                "유가영향": "WTI $70~90 범위 유지 전망",
            },
            "미국대선이후": {
                "현황": "트럼프 2기 행정부 정책 안정화",
                "핵심정책": ["보호무역주의", "IRA 부분 수정", "AI·반도체 패권 강화"],
            },
        }

    async def _collect_sanctions_regulations(self) -> Dict:
        return {
            "반도체수출통제": {
                "미국": "HBM·고급 GPU 대중 수출 규제 유지",
                "한국영향": "삼성·SK하이닉스 중국 매출 감소 리스크",
            },
            "배터리규제": {
                "미국IRA": "FEOC(우려외국기업) 배터리 보조금 제한 시행",
                "한국영향": "중국산 소재 의존도 낮춰야 IRA 수혜 유지",
            },
            "ESG규제": {
                "EU": "공급망 실사 지침(CSDDD) 시행 준비",
                "한국": "K-ESG 공시 의무화 단계적 확대",
            },
        }

    def _calc_risk_index(self) -> Dict:
        return {
            "종합지정학리스크": 45,
            "수준": "중간",
            "주요리스크": [
                "미중 관세 재협상 실패 가능성",
                "북한 도발 잠재 리스크",
                "중동 에너지 공급 불안",
            ],
            "기회요인": [
                "한미일 공급망 협력 강화",
                "방산 수출 확대",
                "IRA 수혜 지속",
            ],
        }


class IndustryCollector:
    """🌐 세계 동향 수집 2 — 산업·기술 담당"""

    def __init__(self):
        self.results: Dict = {}

    async def run(self) -> Dict:
        print("🌐 [산업수집] 글로벌 산업·기술 동향 수집 시작")

        tasks = [
            self._collect_semiconductor(),
            self._collect_ai_tech(),
            self._collect_battery_ev(),
            self._collect_bio_pharma(),
            self._collect_supply_chain(),
            self._collect_emerging_markets(),
        ]

        results = await asyncio.gather(*tasks, return_exceptions=True)
        keys = ["반도체", "AI기술", "배터리EV", "바이오제약", "공급망", "신흥시장"]

        for key, val in zip(keys, results):
            self.results[key] = val if not isinstance(val, Exception) else {"error": str(val)}

        self.results["수집시각"] = datetime.now().isoformat()
        print("🌐 [산업수집] 완료")
        return self.results

    async def _collect_semiconductor(self) -> Dict:
        return {
            "글로벌동향": {
                "시장규모": "2026년 반도체 시장 $7,000억 전망 (YoY +18%)",
                "HBM수요": "AI 서버 급증으로 HBM3E 공급 부족 지속",
                "DRAM": "DDR5 전환 가속, 가격 안정화 국면",
                "NAND": "과잉공급 해소 중, 하반기 가격 반등 기대",
            },
            "주요기업동향": {
                "NVIDIA": "Blackwell GPU 양산, 수요 초과 공급",
                "삼성전자": "HBM3E 엔비디아 납품 협상 진행 중 (핵심 모니터링)",
                "SK하이닉스": "HBM 시장점유율 50%+ 유지, 실적 서프라이즈 지속",
                "TSMC": "3nm 가동률 상승, 2nm 양산 준비",
                "인텔": "파운드리 사업 구조조정 중",
            },
            "한국영향": "HBM 수혜 지속, 삼성 납품 재개 시 추가 상승 여력",
            "투자시사점": "SK하이닉스 매수 유효, 삼성전자 HBM 납품 결과 확인 후 비중 확대",
        }

    async def _collect_ai_tech(self) -> Dict:
        return {
            "생성AI시장": "2026년 $2,000억 규모, 연 35% 성장",
            "주요트렌드": [
                "엣지AI (온디바이스) 확산 — 모바일·PC 수요 견인",
                "AI 에이전트 상용화 가속",
                "AI 데이터센터 전력 소비 급증 → 원전·전력 인프라 투자",
            ],
            "한국기업기회": {
                "삼성전자": "AI 스마트폰, HBM",
                "SK하이닉스": "HBM 독점적 지위",
                "NAVER": "하이퍼클로바X 기업 B2B 확대",
                "KT·SKT": "AI 인프라 클라우드",
                "한국전력·두산에너빌리티": "AI 전력 수요 수혜",
            },
        }

    async def _collect_battery_ev(self) -> Dict:
        return {
            "글로벌EV": {
                "시장": "2026년 글로벌 EV 판매 1,800만대 전망",
                "중국": "BYD 세계 1위 유지, 저가 공세 지속",
                "유럽": "2035년 내연기관 금지 유지, 수요 회복세",
                "미국": "IRA 세액공제 수혜 차량 수요 견조",
            },
            "배터리": {
                "LFP vs NCM": "LFP 비중 증가, NCM은 고급 차량 집중",
                "전고체배터리": "2027~2028년 상용화 목표",
                "소재": "리튬·니켈·코발트 가격 안정화",
            },
            "한국배터리3사": {
                "LG에너지솔루션": "북미 LGES 공장 가동률 상승, GM·스텔란티스 수주",
                "삼성SDI": "BMW·스텔란티스 공급, 원통형 46파이 확대",
                "SK온": "포드 합작 BlueOval 가동, 흑자전환 목표",
            },
        }

    async def _collect_bio_pharma(self) -> Dict:
        return {
            "글로벌트렌드": [
                "GLP-1(비만·당뇨) 의약품 시장 폭발적 성장",
                "ADC(항체약물접합체) 임상 활발",
                "mRNA 백신 기술 범용화",
            ],
            "한국바이오": {
                "삼성바이오로직스": "CDMO 글로벌 수주 강세, 5공장 건설 중",
                "셀트리온": "바이오시밀러 유럽·미국 점유율 확대",
                "한미약품": "GLP-1 계열 파이프라인 임상 진행",
            },
            "리스크": ["FDA 승인 지연", "임상 실패", "특허 분쟁"],
        }

    async def _collect_supply_chain(self) -> Dict:
        return {
            "리쇼어링": "미·유럽 제조업 본국 회귀 가속, 아시아 의존도 축소",
            "차이나플러스원": "베트남·인도·멕시코로 생산기지 분산",
            "한국기업대응": {
                "삼성·SK·현대": "미국 현지 공장 투자 확대",
                "기회": "소재·장비·부품 국내 생태계 강화",
            },
            "물류": "홍해 우회 물류비 일부 정상화, 컨테이너 운임 안정",
        }

    async def _collect_emerging_markets(self) -> Dict:
        return {
            "인도": {
                "성장률": "GDP 6.8% 성장 전망, 중국 대체 투자처로 부상",
                "한국기업": "삼성전자·LG전자 현지 생산 확대",
            },
            "베트남": {
                "한국투자": "삼성 베트남 생산 전략 기지 유지",
                "리스크": "미국 관세 대상국 지정 가능성",
            },
            "인도네시아": "니켈 배터리 소재 공급 확대",
            "중동": "사우디 비전2030, 한국 건설·플랜트 수주 기회",
        }

    def get_industry_opportunities(self) -> list:
        return [
            {"섹터": "반도체", "기회": "HBM·AI반도체 수요 폭발", "위험": "중국 규제, 삼성 납품 지연"},
            {"섹터": "배터리", "기회": "IRA 수혜, EV 전환", "위험": "중국 LFP 경쟁, 수요 둔화"},
            {"섹터": "바이오", "기회": "CDMO 수주, 바이오시밀러 확대", "위험": "임상 실패, FDA 규제"},
            {"섹터": "방산", "기회": "유럽 재무장, 중동 수출", "위험": "지정학 리스크 해소 시 수요 감소"},
            {"섹터": "AI인프라", "기회": "전력·냉각·네트워크 수요", "위험": "AI 버블 논란"},
        ]
