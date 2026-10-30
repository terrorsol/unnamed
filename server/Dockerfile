FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
ENV PORT=8080 DATA_DIR=/data
# Test launches (Render env vars override these):
# - the vault buys its supply in the launch bundle (up to 9 SOL), then sells a slice of every incoming buy into it: ~10% of a small buy up to 30% of a 2 SOL+ buy,
#   first until the launch buy is paid back (never under cost +1%), then only above cost +4%; dip buys / desk bids are small (≤0.2 SOL, ≤0.6 out)
# - Refund / Close & withdraw all sells whatever the vault holds and pays the dev the whole chest
# - launch bundles tip Jito 0.005 SOL; vault trades keep the default tip; test chests up to 10 SOL
ENV LAUNCH_TIP_SOL=0.005 TEST_MAX_CHEST_SOL=10
ENV PROFIT_ONLY=1 TEST_RECLAIM=1 MM_ON=1 DESK_BID=1 MM_WARMUP_MS=0 PROFIT_LAUNCH_BUY_SOL=9 \
    MM_CAPTURE_DAY_CAP=0.5 MM_MAX_BUY_SOL=0.2 MM_MAX_LEG_SOL=0.6 MM_INITIALS_FRAC=0.5 MM_TAKE_FRAC=0.4 \
    MM_DYN_MIN=0.10 MM_DYN_MAX=0.30 MM_DYN_REF_SOL=2
VOLUME ["/data"]
EXPOSE 8080
CMD ["node","--experimental-strip-types","src/index.ts"]
