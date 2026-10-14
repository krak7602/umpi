FROM node:24.20.0-trixie AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src/shared ./src/shared
COPY src/vault ./src/vault
RUN ./node_modules/.bin/esbuild src/vault/server.ts --bundle --platform=node --target=node24 --format=esm --outfile=/out/server.mjs
COPY containers/vault-sync/package.json containers/vault-sync/package-lock.json /opt/headless/
RUN npm ci --prefix /opt/headless --omit=dev --no-audit --no-fund

FROM node:24.20.0-trixie-slim
WORKDIR /app
COPY --from=build /out/server.mjs ./server.mjs
COPY --from=build /opt/headless /opt/headless
RUN mkdir /state && chown node:node /state && chmod 700 /state
ENV UMPI_VAULT_STATE=/state
ENV UMPI_HEADLESS_CLI=/opt/headless/node_modules/obsidian-headless/cli.js
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
