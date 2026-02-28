# ── Use official Playwright Docker image (includes Chromium + all dependencies)
FROM mcr.microsoft.com/playwright:v1.42.0-focal

WORKDIR /app

# Copy package files and install Node dependencies
COPY package*.json ./
RUN npm install --production

# Copy source code
COPY . .

# Expose the port (Railway reads PORT env var)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health', r => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

CMD ["node", "server.js"]
