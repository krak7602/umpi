FROM node:24.20.0-trixie AS build
WORKDIR /build
COPY package.json package-lock.json ./
# The root lockfile installs the vendored obsy packages from these tarballs.
COPY vendor/obsy ./vendor/obsy
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src/shared ./src/shared
COPY src/coding ./src/coding
RUN mkdir -p /out && cc -std=c11 -O2 -Wall -Wextra -Werror src/coding/process-supervisor.c -o /out/umpi-coding-supervisor
RUN ./node_modules/.bin/esbuild src/coding/server.ts --bundle --platform=node --target=node24 --format=esm --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' --outfile=/out/server.mjs

FROM node:24.20.0-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/server.mjs ./server.mjs
COPY --from=build /out/umpi-coding-supervisor /usr/local/libexec/umpi-coding-supervisor
ENV UMPI_CODING_SUPERVISOR=/usr/local/libexec/umpi-coding-supervisor
RUN mkdir /state /workspace && chown node:node /state /workspace && chmod 700 /state /workspace
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
