package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

const chave = "projects/p/locations/r/keyRings/a/cryptoKeys/c"

// Servidor falso: metadados e KMS. "Decifra" tirando o prefixo "cifrado:" do texto em base64.
func servidor(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/computeMetadata/v1/instance/service-accounts/default/token":
			if r.Header.Get("Metadata-Flavor") != "Google" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			json.NewEncoder(w).Encode(map[string]string{"access_token": "tk"})
		case "/v1/" + chave + ":decrypt":
			if r.Header.Get("Authorization") != "Bearer tk" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			var c struct{ Ciphertext string }
			json.NewDecoder(r.Body).Decode(&c)
			bruto, _ := base64.StdEncoding.DecodeString(c.Ciphertext)
			claro, ok := strings.CutPrefix(string(bruto), "cifrado:")
			if !ok {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			json.NewEncoder(w).Encode(map[string]string{"plaintext": base64.StdEncoding.EncodeToString([]byte(claro))})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func cifrado(s string) string { return base64.StdEncoding.EncodeToString([]byte("cifrado:" + s)) }

func TestDecifraTrocaEApagaOsCifrados(t *testing.T) {
	s := servidor(t)
	defer s.Close()
	c := &cliente{metadados: s.URL, api: s.URL, http: s.Client()}
	env, falhas, err := decifrarAmbiente([]string{
		"NT_KMS_CHAVE=" + chave, "PATH=/bin", "SEGREDO_KMS=" + cifrado("abc=def") + "\n", "RUIM_KMS=" + base64.StdEncoding.EncodeToString([]byte("x")),
	}, c)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(env, "SEGREDO=abc=def") || !slices.Contains(env, "PATH=/bin") {
		t.Fatalf("env sem o segredo decifrado: %v", env)
	}
	for _, kv := range env {
		if strings.Contains(kv, "_KMS=") || strings.HasPrefix(kv, "RUIM=") {
			t.Fatalf("sobrou cifrado ou falha no env: %s", kv)
		}
	}
	if !slices.Equal(falhas, []string{"RUIM"}) {
		t.Fatalf("falhas = %v", falhas)
	}
	if f := faltando(env, "SEGREDO RUIM"); !slices.Equal(f, []string{"RUIM"}) {
		t.Fatalf("faltando = %v", f)
	}
}

func TestSemCifradosNaoChamaOKms(t *testing.T) {
	c := &cliente{metadados: "http://127.0.0.1:1", api: "http://127.0.0.1:1", http: http.DefaultClient}
	env, falhas, err := decifrarAmbiente([]string{"A=1"}, c)
	if err != nil || len(falhas) > 0 || !slices.Equal(env, []string{"A=1"}) {
		t.Fatalf("env=%v falhas=%v err=%v", env, falhas, err)
	}
}

func TestExigeAChave(t *testing.T) {
	_, _, err := decifrarAmbiente([]string{"X_KMS=abc"}, novoCliente())
	if err == nil || !strings.Contains(err.Error(), "NT_KMS_CHAVE") {
		t.Fatalf("err = %v", err)
	}
	if got := semCifrados([]string{"X_KMS=abc", "Y=1"}); !slices.Equal(got, []string{"Y=1"}) {
		t.Fatalf("semCifrados = %v", got)
	}
}
