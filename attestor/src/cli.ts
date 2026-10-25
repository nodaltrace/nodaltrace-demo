// CLI do cofre de chaves. Senha por chave: `autoridade` em NT_CHAVES_SENHA_AUTORIDADE, `atestador` em NT_CHAVES_SENHA.
//   gerar <nome>                  par novo → chaves/<nome>.json; imprime só o endereço
//   endereco <nome>               imprime o endereço (não pede senha)
//   conferir <nome>               decifra e sai com 0 (senha certa) ou 1; não imprime segredo nenhum
//   revelar <nome>                segredo base58 (64 bytes) no stdout, só se o stdout NÃO for terminal (para o Cloud
//                                 KMS cifrar: deploy/gcp.sh solana)
//   importar <nome> <arquivo>     importa um par do solana-cli (JSON de 64 números)
import { readFileSync } from 'node:fs';
import { getBase58Decoder } from '@solana/kit';
import { cifrar, decifrar, gravarCofre, lerCofre, lerParSolanaCli, novoPar, senhaDe } from './chaves.js';

const USO = 'uso: cli gerar <nome> | endereco <nome> | conferir <nome> | revelar <nome> | importar <nome> <arquivo-json>';

async function principal(argv: string[]): Promise<void> {
    const [cmd, nome, arquivo] = argv;
    if (!cmd || !nome) throw new Error(USO);
    const senha = senhaDe(nome) ?? '';
    switch (cmd) {
        case 'gerar': {
            const par = await novoPar();
            const cofre = await cifrar(par, senha);
            par.fill(0);
            gravarCofre(nome, cofre);
            console.log(cofre.endereco);
            return;
        }
        case 'importar': {
            if (!arquivo) throw new Error(USO);
            const par = lerParSolanaCli(readFileSync(arquivo, 'utf8'));
            const cofre = await cifrar(par, senha);
            par.fill(0);
            gravarCofre(nome, cofre);
            console.log(cofre.endereco);
            return;
        }
        case 'endereco':
            console.log(lerCofre(nome).endereco);
            return;
        case 'conferir': {
            (await decifrar(lerCofre(nome), senha)).fill(0);
            return;
        }
        case 'revelar': {
            if (process.stdout.isTTY) throw new Error('recuso imprimir o segredo num terminal; redirecione (ex.: | gcloud kms encrypt …)');
            const par = await decifrar(lerCofre(nome), senha);
            process.stdout.write(getBase58Decoder().decode(par));
            par.fill(0);
            return;
        }
        default:
            throw new Error(USO);
    }
}

principal(process.argv.slice(2)).catch(e => {
    console.error((e as Error).message);
    process.exit(1);
});
