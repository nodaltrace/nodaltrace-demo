FROM python:3.12-slim
WORKDIR /app
COPY requirements-dev.txt .
# O wheel do rasterio (via rio-tiler) depende da libexpat, que o python:3.12-slim não tem.
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*
# Só a trava (versões exatas e hashes, ver api/pyproject.toml): reconstruir a imagem nunca troca versão.
RUN pip install --no-cache-dir --require-hashes -r requirements-dev.txt
COPY . .
