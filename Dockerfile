# PAP Heartbeat Collector
# Multi-stage build for minimal production image

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

# Security: Run as non-root user
RUN addgroup -g 1001 -S pap && \
    adduser -u 1001 -S pap -G pap

WORKDIR /app

# Copy production dependencies and built files
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Set ownership
RUN chown -R pap:pap /app

# Switch to non-root user
USER pap

# Default port
ENV COLLECTOR_PORT=8080

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
