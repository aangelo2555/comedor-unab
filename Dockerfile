FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
