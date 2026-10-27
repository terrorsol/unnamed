FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV PORT=8080 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node","--experimental-strip-types","src/index.ts"]
