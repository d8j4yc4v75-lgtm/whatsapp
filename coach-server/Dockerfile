FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . ./
# Datos del coach; en Railway se monta aquí un volumen
ENV DATA_DIR=/data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
