# attestor da nuvem: a imagem de attestor/Dockerfile (BASE) com o kms-exec, que decifra as chaves e os segredos HMAC
# pelo Cloud KMS antes de subir (ver deploy/service.yaml). Contexto: a raiz.
ARG BASE
ARG KMS_EXEC
FROM ${KMS_EXEC} AS kms
FROM ${BASE}
COPY --from=kms /kms-exec /usr/local/bin/kms-exec
COPY --from=kms /ca-certificates.crt /usr/local/share/kms-exec/ca-certificates.crt
ENTRYPOINT ["/usr/local/bin/kms-exec"]
# Contêiner auxiliar: se o attestor cair (RPC fora, por exemplo), sobe de novo em vez de sair e derrubar a instância.
CMD ["sh", "-c", "while true; do node dist/servidor.js; echo 'attestor saiu; reinicio em 15 s' >&2; sleep 15; done"]
