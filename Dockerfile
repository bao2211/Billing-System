# syntax=docker/dockerfile:1
FROM node:20-alpine

# Install zip for archive creation
RUN apk add --no-cache zip

WORKDIR /app

# Install dependencies first (for layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application code
COPY . .

# Create required directories and set permissions
RUN mkdir -p downloads profiles sessions public && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodeuser -u 1001 -G nodejs && \
    chown -R nodeuser:nodejs /app



EXPOSE 4310

ENV NODE_ENV=production
ENV PORT=4310

CMD ["node", "src/server.js"]
