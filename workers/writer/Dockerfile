FROM oven/bun:1.3.14-alpine

RUN apk add --no-cache git

WORKDIR /app

# These are private virtual hosts intercepted by the Writer Worker. They are
# routing configuration, not credentials, so baking them into the image keeps
# every Container process on the R2-backed Store.
ENV REGISTRY_R2_INTERNAL_URL=http://registry-r2 \
    REGISTRY_R2_MUTABLE_URL=http://registry-mutable

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
