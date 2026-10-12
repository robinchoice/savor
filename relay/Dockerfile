# The relay image: the relay and the web app it serves. Build dist/ first (npm ci) and use it as the
# context: docker build -f relay/Dockerfile dist
FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node relay ./relay
COPY --chown=node:node web ./web
# The installation counts (relay/usage.ts). Mount a volume here so they survive a redeploy.
RUN mkdir data && chown node:node data
ENV RELAY_PORT=8787 RELAY_WEB_DIR=/app/web RELAY_TRUST_PROXY=1 RELAY_DB=/app/data/usage.db
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "relay/server.mjs"]
