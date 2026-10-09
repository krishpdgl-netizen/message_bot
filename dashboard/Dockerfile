FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

# The SQLite database lives here, on a named volume owned by the node user.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
