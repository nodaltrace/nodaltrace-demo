# Pipeline para os jobs da nuvem (migrações e cargas): o código vai na imagem, em vez dos volumes do Compose.
# Contexto: a raiz do repositório.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.13.3
# Só a trava (versões exatas e hashes, ver pipeline/requirements.in): reconstruir a imagem nunca troca versão.
COPY pipeline/requirements.txt /tmp/requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir --break-system-packages --require-hashes -r /tmp/requirements.txt
ENV PYTHONPATH=/db PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY pipeline/ .
COPY db/*.sql /db/
COPY db/nt_db /db/nt_db
ENTRYPOINT ["python3", "-m", "nt_pipeline"]
