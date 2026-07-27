FROM oven/bun:1.3.14-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY registries ./registries
COPY scripts ./scripts
COPY server ./server
COPY skills ./skills

CMD ["sh", "-c", "while :; do sleep 3600; done"]
