FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
ENV PORT=8080 DATA_DIR=/data
# test launches: the vault never spends SOL on the coin (no dip buys, no desk bid, no block-zero buy, never sells under cost +4%)
# and the dev can reclaim the whole chest once it holds no tokens. Render env vars override these.
ENV PROFIT_ONLY=1 TEST_RECLAIM=1 MM_BUYS=0 DESK_BID=0
VOLUME ["/data"]
EXPOSE 8080
CMD ["node","--experimental-strip-types","src/index.ts"]
