FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
ENV PORT=8080 DATA_DIR=/data
# test launches: the market maker buys only when the last hour traded enough to exit at a profit, never sells under cost +4%,
# block-zero vault buy up to 3.5 SOL, no post-arm wait; Refund sells whatever the vault holds and pays the dev the whole chest. Render env vars override these.
ENV PROFIT_ONLY=1 TEST_RECLAIM=1 MM_ON=1 DESK_BID=1 MM_WARMUP_MS=0 PROFIT_LAUNCH_BUY_SOL=4 \
    MM_CAPTURE_DAY_CAP=0.5 MM_MAX_BUY_SOL=0.25 MM_MAX_LEG_SOL=1
VOLUME ["/data"]
EXPOSE 8080
CMD ["node","--experimental-strip-types","src/index.ts"]
