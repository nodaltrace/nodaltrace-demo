# Porta de entrada da demo no Railway: o frontend compilado e o nginx, que repassa /api e /tiles para os serviços `api` e
# `martin` pela rede privada (deploy/demo/nginx.conf.template). Contexto: a raiz do repositório.
FROM node:24-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
# Vetores de teste da atestação: os testes do frontend os importam e o `tsc` do build confere os testes também.
COPY docs/atestacao/vetores.json /docs/atestacao/vetores.json
# O Railway passa as variáveis do serviço como argumentos do build.
# Token público do Mapbox (pk.…), restrito ao endereço da demo; sem ele, o mapa fica só no estilo neutro.
ARG VITE_MAPBOX_TOKEN=
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
# Autoridade da credencial NODALTRACE (pública): a página de verificação deriva credencial e schema sem confiar na API.
ARG VITE_NT_AUTORIDADE=
ENV VITE_NT_AUTORIDADE=$VITE_NT_AUTORIDADE
RUN npm run build

FROM nginx:1.29-alpine
# Nomes dos outros serviços na rede privada; o entrypoint da imagem os põe no template, com os resolvedores do
# /etc/resolv.conf em NGINX_LOCAL_RESOLVERS.
ENV API_HOST=api.railway.internal MARTIN_HOST=martin.railway.internal NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY deploy/demo/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web /web/dist /usr/share/nginx/html
