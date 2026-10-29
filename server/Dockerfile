FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
ENV PORT=8080 DATA_DIR=/data
# test launches: the market maker buys only when the last hour traded enough to exit at a profit, never sells under cost +4%,
# no block-zero buy; Refund sells whatever the vault holds and pays the dev the whole chest. Render env vars override these.
ENV PROFIT_ONLY=1 TEST_RECLAIM=1 MM_ON=1 DESK_BID=1
VOLUME ["/data"]
EXPOSE 8080
CMD ["node","--experimental-strip-types","src/index.ts"]
