# Savor's demo instance for Apple's beta review (demo/start.mjs). It only connects out to the relay and
# needs no port. Build from the repo: docker build -f demo/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx vite build && npm run build:server

FROM node:24-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /src/dist ./dist
COPY test/fake-claude.mjs demo/start.mjs ./demo/
# The state (the daemon's key, which the pairing link names) lives in a volume, so the link survives a redeploy.
RUN mkdir /data && chown node:node /data
ENV SAVOR_HOME=/data SAVOR_PORT=4317 SAVOR_CLAUDE_BIN=/app/demo/fake-claude.mjs FAKE_AGENT_LOG=/dev/null
USER node
RUN git config --global user.name Savor && git config --global user.email demo@savor.invalid
CMD ["node", "demo/start.mjs"]
