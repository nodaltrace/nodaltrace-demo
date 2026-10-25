# GDAL (ogr2ogr) para ler shapefile e GeoPackage do SICAR.
# A mesma versão de deploy/pipeline.Dockerfile: a `latest` é um build noturno de desenvolvimento do GDAL.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.13.3
# Só a trava (versões exatas e hashes, ver pipeline/requirements.in): reconstruir a imagem nunca troca versão.
COPY requirements.txt /tmp/requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir --break-system-packages --require-hashes -r /tmp/requirements.txt
WORKDIR /app
ENTRYPOINT ["python3", "-m", "nt_pipeline"]
