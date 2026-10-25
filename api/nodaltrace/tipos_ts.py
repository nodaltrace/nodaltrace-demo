"""Gera web/src/api/contrato.ts: uma interface TypeScript por modelo de resposta (modelos/), a partir do OpenAPI da API,
com as docstrings como comentários. O frontend importa os tipos de web/src/api/tipos.ts, que dá os nomes a eles.

Uso: ./run.sh tipos (ou `python -m nodaltrace.tipos_ts > ../web/src/api/contrato.ts`). A CI confere que o arquivo do
repositório é o que sai daqui."""

from __future__ import annotations

import json
import os
import sys

CABECALHO = ('// Gerado por api/nodaltrace/tipos_ts.py a partir do OpenAPI da API (./run.sh tipos). Não edite: mude os modelos em\n'
             '// api/nodaltrace/modelos/ e gere de novo.\n')
#: Esquemas do FastAPI que o frontend não usa.
FORA = {'HTTPValidationError', 'ValidationError'}


def _nome(ref: str) -> str:
    return ref.rsplit('/', 1)[-1]


def _uniao(partes: list[str]) -> str:
    return ' | '.join(dict.fromkeys(partes))


def _literal(v) -> str:
    """Literal no estilo do frontend: texto entre aspas simples."""
    if isinstance(v, str):
        return "'" + v.replace('\\', '\\\\').replace("'", "\\'") + "'"
    return json.dumps(v)


def tipo(e: dict) -> str:
    """O tipo TypeScript de um esquema JSON do OpenAPI 3.1 (o subconjunto que o Pydantic gera)."""
    if '$ref' in e:
        return _nome(e['$ref'])
    for chave in ('anyOf', 'oneOf'):
        if chave in e:
            return _uniao([tipo(x) for x in e[chave]])
    if 'const' in e:
        return _literal(e['const'])
    if 'enum' in e:
        return _uniao([_literal(v) for v in e['enum']])
    t = e.get('type')
    if isinstance(t, list):
        return _uniao([tipo({**e, 'type': x}) for x in t])
    if t == 'string':
        return 'string'
    if t in ('integer', 'number'):
        return 'number'
    if t in ('boolean', 'null'):
        return t
    if t == 'array':
        if 'prefixItems' in e:
            return '[' + ', '.join(tipo(x) for x in e['prefixItems']) + ']'
        item = tipo(e.get('items', {}))
        return f'({item})[]' if ' | ' in item else f'{item}[]'
    if t == 'object':
        extra = e.get('additionalProperties', True)
        return f'Record<string, {tipo(extra)}>' if isinstance(extra, dict) and extra else 'Record<string, unknown>'
    return 'unknown'


def _comentario(texto: str | None, recuo: str) -> list[str]:
    if not texto:
        return []
    linhas = ' '.join(texto.split()).replace('*/', '*\\/')
    return [f'{recuo}/** {linhas} */']


def interface(nome: str, e: dict) -> str:
    obrigatorios = set(e.get('required', []))
    linhas = [*_comentario(e.get('description'), ''), f'export interface {nome} {{']
    for campo, prop in e.get('properties', {}).items():
        linhas += _comentario(prop.get('description'), '  ')
        linhas.append(f'  {campo}{"" if campo in obrigatorios else "?"}: {tipo(prop)}')
    linhas.append('}')
    return '\n'.join(linhas)


def gerar(openapi: dict) -> str:
    esquemas = openapi['components']['schemas']
    return CABECALHO + ''.join(f'\n{interface(n, esquemas[n])}\n' for n in sorted(esquemas) if n not in FORA)


if __name__ == '__main__':
    # Só o esquema: o pool do banco não abre, mas banco.py exige a variável.
    os.environ.setdefault('DATABASE_URL', 'postgresql://')
    from .main import app

    sys.stdout.write(gerar(app.openapi()))
