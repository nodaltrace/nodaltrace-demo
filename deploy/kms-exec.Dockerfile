# kms-exec (deploy/kms-exec): binário estático, copiado pelas imagens da API e do attestor. Contexto: a raiz.
FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY deploy/kms-exec/ .
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /kms-exec .

FROM scratch
COPY --from=build /kms-exec /kms-exec
COPY --from=build /etc/ssl/certs/ca-certificates.crt /ca-certificates.crt
