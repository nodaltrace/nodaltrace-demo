# Martin com a configuração do repositório embutida. Contexto: a raiz do repositório.
FROM ghcr.io/maplibre/martin:1.16.1
COPY martin/martin.yaml /config/martin.yaml
CMD ["--config", "/config/martin.yaml"]
