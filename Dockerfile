# Dockerfile optimizado para Railway - Consumo ultra-bajo de RAM (< 40MB)
FROM node:20-alpine

# Metadatos
LABEL maintainer="Angelo Thomas Serna Simeon"
LABEL description="Comedor UNAB Portal & Sniper para Railway"

WORKDIR /app

# Copiar archivos esenciales
COPY package*.json ./
COPY . .

# Asegurar que el directorio de datos existe y tiene permisos completos de lectura/escritura
RUN mkdir -p /app/data && chmod -R 777 /app /app/data

# Variables de entorno por defecto (Railway inyecta PORT dinamicamente)
ENV PORT=3000
ENV NODE_ENV=production

# Puerto expuesto
EXPOSE 3000

# Comando de inicio (ejecuta como root en el contenedor para permitir escritura en /app/data y volumenes persistentes de Railway)
CMD ["node", "server.js"]

