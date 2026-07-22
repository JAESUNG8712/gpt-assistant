FROM node:22-bookworm-slim
# node:18 → node:22 (2026-07-22): pdf-parse가 내부적으로 쓰는 pdfjs-dist가 브라우저 전용
# API(DOMMatrix/ImageData/Path2D)를 폴리필할 때 Node의 `process.getBuiltinModule`을
# 참조하는데, 이 API는 Node 20.16/22.3부터 존재한다. Node 18에서는 이 폴리필이 조용히
# 실패해("Cannot polyfill DOMMatrix..." 경고만 남기고 계속 진행) 이력서 PDF 텍스트
# 추출이 이름/학력/경력을 포함해 통째로 실패하는 문제로 실측 확인됐다(Docker 런타임
# 전환 직후 발견). package.json의 engines가 이미 ">=18.0.0"이라 22로 올려도 호환된다.

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-kor \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir "setuptools<60" wheel \
    && pip3 install --break-system-packages --no-cache-dir six pyhwp

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
