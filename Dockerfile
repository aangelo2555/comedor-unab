# Dockerfile optimizado para Railway - Consumo ultra-bajo de RAM (< 40MB)
FROM node:20-alpine

# Metadatos
LABEL maintainer="Angelo Thomas Serna Simeon"
LABEL description="Comedor UNAB Portal & Sniper para Railway"

WORKDIR /app

# Copiar archivos esenciales
COPY package.json ./
COPY . .

# Variables de entorno por defecto (Railway inyecta PORT dinamicamente)
ENV PORT=3000
ENV NODE_ENV=production

# Puerto expuesto
EXPOSE 3000

# Ejecutar con usuario no-root por seguridad
USER node

# Comando de inicio
CMD ["node", "server.js"]
