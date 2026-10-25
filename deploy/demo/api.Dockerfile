# API da demo no Railway: o deploy/api.Dockerfile sem o kms-exec; os segredos chegam nas variáveis do
# serviço. Contexto: a raiz do repositório.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
# O wheel do rasterio (via rio-tiler) depende da libexpat, que o python:3.12-slim não tem.
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*
# Só a trava (versões exatas e hashes, ver api/pyproject.toml): reconstruir a imagem nunca troca versão.
COPY api/requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY api/nodaltrace nodaltrace
# Um worker só. IPv4, como o nginx do gateway pede (`ipv6=off`): com `::`, o uvicorn escuta só em IPv6. De fora, só o
# gateway tem domínio.
CMD ["uvicorn", "nodaltrace.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
