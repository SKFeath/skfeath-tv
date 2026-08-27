FROM node:22-alpine

WORKDIR /app

# Install deps first so rebuilds skip this layer when only source changes.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Fan-out holds segments in memory; the default window is small (~20-30 MB).
CMD ["node", "server.js"]
