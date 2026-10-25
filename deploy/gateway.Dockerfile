# Porta de entrada do serviço na nuvem (ver deploy/service.yaml): o frontend compilado e o nginx, que repassa /api e
# /tiles para os outros contêineres da instância, como o proxy do Vite faz no ambiente local. Contexto: a raiz.
FROM node:24-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
# Vetores de teste da atestação: os testes do frontend os importam e o `tsc` do build confere os testes também.
COPY docs/atestacao/vetores.json /docs/atestacao/vetores.json
# Token público do Mapbox (pk.…), embutido no build; sem ele, o mapa fica só no estilo neutro.
ARG VITE_MAPBOX_TOKEN=
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
# Autoridade da credencial NODALTRACE (pública): a página de verificação deriva credencial e schema sem confiar na API.
ARG VITE_NT_AUTORIDADE=
ENV VITE_NT_AUTORIDADE=$VITE_NT_AUTORIDADE
RUN npm run build

FROM nginx:1.29-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web /web/dist /usr/share/nginx/html
