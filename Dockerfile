FROM node:22-bookworm-slim

# ffmpeg convierte notas de voz y videos al formato de WhatsApp;
# python3, make y g++ compilan better-sqlite3 cuando no hay binario precompilado
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
# La app de correos corre dentro del mismo servidor (pestaña «Correos»)
COPY mail/src ./mail/src
COPY mail/public ./mail/public

# Sesiones, mensajes y archivos; en Railway se monta aquí un volumen
ENV DATA_DIR=/data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
