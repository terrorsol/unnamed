FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
ENV PORT=8080 DATA_DIR=/data
# Test launches (Render env vars override these):
# - the vault buys its supply in the launch bundle (up to 9 SOL), then sells a slice of every incoming buy into it: ~8% of a small buy up to 25% of a 2 SOL+ buy
#   (was 10–30%; replaying the five real launch tapes of Oct 29–30, 8–25% kept +9% more SOL: the chest holds a little longer into the run),
#   first until the launch buy is paid back (never under cost +1%), then only above cost +4%; dip buys / desk bids are small (≤0.2 SOL, ≤0.6 out)
# - Refund / Close & withdraw all sells whatever the vault holds and pays the dev the whole chest
# - pump.fun launches: for 20 s after the launch lands, half of every buy's SOL is sold straight back into it by the chest (sniper tax),
#   on the fast path (processed-logs feed, direct pump sell, pool-priced fees); 15% of the block-zero tokens stay for market making after
# - launch bundles tip Jito 0.005 SOL; vault trades keep the default tip; test chests up to 10 SOL
ENV LAUNCH_TIP_SOL=0.005 TEST_MAX_CHEST_SOL=10
# 'Close & withdraw all' (TEST_RECLAIM) only for the owner's wallets and any wallet bound to the same beta key
ENV TEST_RECLAIM_WALLETS=7BAdBZxhisBAJH8PGMADKp8thz8yqk2AmaoHZq92mmvb,5MHbsDZaNTzNLhcn7JNNgQ2zTm2ooyr4xHXEV1uwxrqt,HuZGx4k41dCPuXR4PnBNdHNXJ4WzbUnDxo9wvU3VpXAY
ENV PROFIT_ONLY=1 TEST_RECLAIM=1 MM_ON=1 DESK_BID=1 MM_WARMUP_MS=0 PROFIT_LAUNCH_BUY_SOL=9 \
    MM_CAPTURE_DAY_CAP=0.5 MM_MAX_BUY_SOL=0.2 MM_MAX_LEG_SOL=0.6 MM_INITIALS_FRAC=0.5 MM_TAKE_FRAC=0.4 \
    MM_DYN_MIN=0.08 MM_DYN_MAX=0.25 MM_DYN_REF_SOL=2 \
    MM_SNIPER_FRAC=0.5 MM_SNIPER_WINDOW_MS=20000 MM_SNIPER_KEEP=0.15 MM_SNIPER_MIN_BUY=0.03
VOLUME ["/data"]
EXPOSE 8080
CMD ["node","--experimental-strip-types","src/index.ts"]
