FROM oven/bun:1.3.14-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY registries ./registries
COPY registry ./registry
COPY scripts ./scripts
COPY archive ./archive

# The Writer uses this container via exec only; no service listens here.
# Wrangler local dev still requires an exposed port to manage the container.
EXPOSE 8080

CMD ["sh", "-c", "while :; do sleep 3600; done"]
