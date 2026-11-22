# Lightweight Alpine Node.js image (~150MB total, ~70MB runtime RAM)
FROM node:22-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY src ./src

ENV NODE_ENV=production

# Optional healthcheck port (Render, Koyeb, Railway, UptimeRobot)
EXPOSE 3000

CMD ["node", "src/index.js"]
