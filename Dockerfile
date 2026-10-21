FROM node:22-bookworm-slim

# ffmpeg convierte notas de voz y videos al formato de WhatsApp
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./

# Sesiones, mensajes y archivos; en Railway se monta aquí un volumen
ENV DATA_DIR=/data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
