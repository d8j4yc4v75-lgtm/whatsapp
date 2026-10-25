FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . ./

ENV DATA_DIR=/data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
