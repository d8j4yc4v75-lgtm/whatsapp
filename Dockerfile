FROM node:22-slim
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev
COPY index.html ./
COPY server/index.js server/
ENV PORT=3000 AUTH_DIR=/data/auth
EXPOSE 3000
CMD ["node", "server/index.js"]
