# API para a nuvem. Contexto: a raiz do repositório.
# KMS_EXEC: a imagem de deploy/kms-exec.Dockerfile, que decifra o segredo do attestor na subida.
ARG KMS_EXEC
FROM ${KMS_EXEC} AS kms
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
# O wheel do rasterio (via rio-tiler) depende da libexpat, que o python:3.12-slim não tem.
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*
# Só a trava (versões exatas e hashes, ver api/pyproject.toml): reconstruir a imagem nunca troca versão.
COPY api/requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY api/nodaltrace nodaltrace
COPY --from=kms /kms-exec /usr/local/bin/kms-exec
COPY --from=kms /ca-certificates.crt /usr/local/share/kms-exec/ca-certificates.crt
# Sem o segredo decifrado, a API sobe mesmo assim e mostra a atestação como indisponível (NT_KMS_FALHA=seguir).
ENTRYPOINT ["/usr/local/bin/kms-exec"]
# Um worker só: a instância do Cloud Run tem 1 vCPU para a API.
# 0.0.0.0 para a sonda de inicialização do Cloud Run, que não usa o loopback; de fora, só a porta do nginx é exposta.
CMD ["uvicorn", "nodaltrace.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
