# ---- frontend build -------------------------------------------------------
# static files are architecture-independent: build them once, natively
FROM --platform=$BUILDPLATFORM node:22.12-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM python:3.12.8-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FAVA_ASSET_DIR=/assets \
    FAVA_DATA_DIR=/data \
    FAVA_STATIC_DIR=/app/static \
    PORT=8080
WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/fava ./fava
COPY --from=web /web/dist ./static
RUN useradd --uid 1000 --create-home fava && mkdir -p /data /assets && chown fava /data
USER fava
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/config')"
CMD ["python", "-m", "fava"]
