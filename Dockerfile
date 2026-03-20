# ============================================================================
# 1min-relay — Multi-stage Docker Build
# ============================================================================

# Stage 1: Build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Stage 2: Production
FROM node:22-alpine AS production
RUN apk add --no-cache tini
WORKDIR /app

# Copy only production artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

# Non-root user
RUN addgroup -g 1001 -S relay && \
    adduser -S relay -u 1001 && \
    chown -R relay:relay /app
USER relay

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
