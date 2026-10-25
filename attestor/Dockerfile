# node:22-slim, fixado por digest (índice multiplataforma). Para atualizar: docker pull node:22-slim e
# docker image inspect node:22-slim --format '{{json .RepoDigests}}'.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
WORKDIR /app
ENV NODE_ENV=production NT_CHAVES_DIR=/app/chaves PORT=8790
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Cofres por bind mount: no servidor, só atestador.json; no setup, só autoridade.json (um arquivo por bind, só
# leitura); os fundos não montam cofre; a CLI do run.sh monta o diretório inteiro.
# O container roda com o UID do host (dono dos cofres, 0600), que pode não ser o `node`: o diretório só precisa ser
# atravessável (0711); quem protege são os arquivos. Nada aqui depende de HOME.
RUN mkdir -p /app/chaves && chmod 711 /app/chaves
USER node
EXPOSE 8790
CMD ["node", "dist/servidor.js"]
