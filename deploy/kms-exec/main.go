// kms-exec decifra segredos com o Cloud KMS e executa um comando com eles no ambiente.
//
// Uso: kms-exec <comando> [args...]
//
// Cada env NOME_KMS traz um texto cifrado pelo Cloud KMS, em base64 (o que `gcloud kms encrypt` grava, codificado
// pelo deploy/gcp.sh solana). O kms-exec o decifra com a chave de NT_KMS_CHAVE, usando a conta de serviço da instância
// (servidor de metadados), põe o texto claro em NOME, apaga NOME_KMS e substitui o próprio processo pelo comando
// (execve). Assim o segredo fica guardado só cifrado (Secret Manager) e quem decifra é a IAM da chave do KMS, sem
// senha guardada em lugar nenhum.
//
//	NT_KMS_CHAVE   projects/<p>/locations/<r>/keyRings/<anel>/cryptoKeys/<chave>
//	NT_KMS_EXIGIR  nomes (separados por espaço) que precisam existir depois de decifrar
//	NT_KMS_FALHA   esperar (padrão): tenta de novo a cada 30 s, sem sair, para um contêiner auxiliar nunca derrubar a
//	               instância; seguir: executa o comando sem os segredos que falharam (a API sobe sem a atestação)
package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const sufixo = "_KMS"

// Certificados raiz levados junto do binário (deploy/kms-exec.Dockerfile): imagens como a node:22-slim não têm os do
// sistema, e a API do KMS é HTTPS.
const certificados = "/usr/local/share/kms-exec/ca-certificates.crt"

type cliente struct {
	metadados string // servidor de metadados (token da conta de serviço)
	api       string // API do Cloud KMS
	http      *http.Client
}

func novoCliente() *cliente {
	transporte := http.DefaultTransport.(*http.Transport).Clone()
	if pem, err := os.ReadFile(certificados); err == nil {
		raizes := x509.NewCertPool()
		if raizes.AppendCertsFromPEM(pem) {
			transporte.TLSClientConfig = &tls.Config{RootCAs: raizes}
		}
	}
	return &cliente{
		metadados: "http://metadata.google.internal",
		api:       "https://cloudkms.googleapis.com",
		http:      &http.Client{Timeout: 20 * time.Second, Transport: transporte},
	}
}

func (c *cliente) token() (string, error) {
	req, _ := http.NewRequest(http.MethodGet, c.metadados+"/computeMetadata/v1/instance/service-accounts/default/token", nil)
	req.Header.Set("Metadata-Flavor", "Google")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("servidor de metadados: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("servidor de metadados: HTTP %d", resp.StatusCode)
	}
	var r struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil || r.AccessToken == "" {
		return "", errors.New("servidor de metadados: resposta sem token")
	}
	return r.AccessToken, nil
}

func (c *cliente) decifrar(chave, token, cifrado string) (string, error) {
	corpo, _ := json.Marshal(map[string]string{"ciphertext": cifrado})
	req, _ := http.NewRequest(http.MethodPost, c.api+"/v1/"+chave+":decrypt", bytes.NewReader(corpo))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("Cloud KMS: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		detalhe, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return "", fmt.Errorf("Cloud KMS: HTTP %d %s", resp.StatusCode, strings.TrimSpace(string(detalhe)))
	}
	var r struct {
		Plaintext string `json:"plaintext"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return "", errors.New("Cloud KMS: resposta inválida")
	}
	claro, err := base64.StdEncoding.DecodeString(r.Plaintext)
	if err != nil {
		return "", errors.New("Cloud KMS: texto claro não é base64")
	}
	if bytes.IndexByte(claro, 0) >= 0 {
		return "", errors.New("texto claro com byte nulo não cabe numa env")
	}
	return string(claro), nil
}

// decifrarAmbiente devolve o ambiente com cada NOME_KMS trocado por NOME (decifrado) e os nomes que falharam.
// Os valores dos segredos nunca entram nas mensagens de erro.
func decifrarAmbiente(env []string, c *cliente) (saida []string, falhas []string, err error) {
	var chave string
	cifrados := map[string]string{}
	for _, kv := range env {
		nome, valor, _ := strings.Cut(kv, "=")
		switch {
		case nome == "NT_KMS_CHAVE":
			chave = valor
			saida = append(saida, kv)
		case strings.HasSuffix(nome, sufixo) && len(nome) > len(sufixo):
			cifrados[strings.TrimSuffix(nome, sufixo)] = strings.TrimSpace(valor)
		default:
			saida = append(saida, kv)
		}
	}
	if len(cifrados) == 0 {
		return saida, nil, nil
	}
	if chave == "" {
		return nil, nil, errors.New("há envs *_KMS mas falta NT_KMS_CHAVE")
	}
	token, err := c.token()
	if err != nil {
		return nil, nil, err
	}
	for nome, cifrado := range cifrados {
		claro, err := c.decifrar(chave, token, cifrado)
		if err != nil {
			log.Printf("kms-exec: %s: %v", nome, err)
			falhas = append(falhas, nome)
			continue
		}
		saida = append(saida, nome+"="+claro)
	}
	return saida, falhas, nil
}

func semCifrados(env []string) []string {
	var saida []string
	for _, kv := range env {
		if nome, _, _ := strings.Cut(kv, "="); !strings.HasSuffix(nome, sufixo) {
			saida = append(saida, kv)
		}
	}
	return saida
}

func faltando(env []string, exigir string) []string {
	tem := map[string]bool{}
	for _, kv := range env {
		nome, valor, _ := strings.Cut(kv, "=")
		tem[nome] = valor != ""
	}
	var f []string
	for _, nome := range strings.Fields(exigir) {
		if !tem[nome] {
			f = append(f, nome)
		}
	}
	return f
}

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		log.Fatal("uso: kms-exec <comando> [args...]")
	}
	caminho, err := exec.LookPath(os.Args[1])
	if err != nil {
		log.Fatalf("kms-exec: %v", err)
	}
	seguir := os.Getenv("NT_KMS_FALHA") == "seguir"
	c := novoCliente()
	for {
		env, falhas, err := decifrarAmbiente(os.Environ(), c)
		if err != nil {
			env = semCifrados(os.Environ())
		} else if f := faltando(env, os.Getenv("NT_KMS_EXIGIR")); len(f) > 0 {
			err = fmt.Errorf("faltam %s", strings.Join(f, ", "))
		} else if len(falhas) > 0 {
			err = fmt.Errorf("não decifrou %s", strings.Join(falhas, ", "))
		}
		if err == nil || seguir {
			if err != nil {
				log.Printf("kms-exec: %v; seguindo sem eles", err)
			}
			log.Fatalf("kms-exec: %v", syscall.Exec(caminho, os.Args[1:], env))
		}
		log.Printf("kms-exec: %v; tento de novo em 30 s", err)
		time.Sleep(30 * time.Second)
	}
}
