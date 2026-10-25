"""Emissão de relatórios de análise: o usuário seleciona imóveis do CAR, escolhe as análises do catálogo e o resultado
vira um registro imutável, numerado na série do banco, cujo documento são as folhas de uma árvore de Merkle
(dominio/relatorio.py). A raiz vai para a Solana (servicos/ancoragem.py); o PDF é uma renderização do registro.

Um relatório errado não muda: corrige-se com outro que o substitui (`substitui` + `motivo`), registrado do mesmo jeito.
"""

from __future__ import annotations

import secrets
import unicodedata
from datetime import datetime, timezone

from psycopg import Connection
from psycopg.errors import UniqueViolation

from ..consultas import imoveis, relatorios
from ..dominio import relatorio as documento
from ..dominio.conformidade import GRAVIDADE, VERSAO_REGRAS, veredito
from ..erros import Conflito, NaoEncontrado, PedidoInvalido
from ..modelos.relatorios import ItemCabecalho, ItemImovel, ItemResumo
from .catalogo import ANALISES, POR_ID, Bases, Selecao


def _sal() -> str:
    return secrets.token_hex(32)


def _motivo(substitui: str | None, motivo: str | None) -> str | None:
    """O motivo da correção, sem espaços nas pontas e em NFC; obrigatório com `substitui`, proibido sem."""
    texto = unicodedata.normalize('NFC', motivo.strip()) if motivo else None
    if substitui and not texto:
        raise PedidoInvalido('Correcting a report requires a reason')
    if texto and not substitui:
        raise PedidoInvalido('A reason is only accepted when correcting a report (substitui)')
    return texto


def emitir(con: Connection, pedidos: list[str], analises: list[str], substitui: str | None = None, motivo: str | None = None) -> dict:
    """Aplica as análises aos imóveis e grava o relatório, com o registro na rede pendente. O documento sai na ordem do
    catálogo e na dos imóveis pedidos (sem repetição), qualquer que seja a ordem dos cliques."""
    cods = list(dict.fromkeys(c.strip().upper() for c in pedidos if c.strip()))
    ids = list(dict.fromkeys(analises))
    motivo = _motivo(substitui, motivo)
    if desconhecidas := [a for a in ids if a not in POR_ID]:
        raise PedidoInvalido(f'Unknown analyses: {", ".join(desconhecidas)}')
    escolhidas = [a for a in ANALISES if a.id in ids]

    corrigido = None
    if substitui:
        corrigido = relatorios.para_corrigir(con, substitui)
        if not corrigido:
            raise NaoEncontrado(f'Report {substitui} not found')
        if corrigido['substituido_por']:
            raise Conflito(f'Report {substitui} has already been superseded by {corrigido["substituido_por"]}: correct that one instead')

    b = Bases(con)
    textos_bases = {a.id: a.base(b) for a in escolhidas}
    if indisponiveis := [a.nome for a in escolhidas if textos_bases[a.id] is None]:
        raise PedidoInvalido(f'Data source not loaded for: {", ".join(indisponiveis)}')
    por_cod = imoveis.que_valem(con, cods)
    if ausentes := [c for c in cods if c not in por_cod]:
        raise PedidoInvalido(f'CAR not found in the database: {", ".join(ausentes)}')

    selecao = Selecao(con, [por_cod[c] for c in cods], b)
    resultados = {a.id: a.executar(selecao) for a in escolhidas}
    itens_imoveis = []
    for i in selecao.imoveis:
        cod = i['cod_imovel']
        linhas = [{'analise': a.id, **vars(resultados[a.id][cod])} for a in escolhidas]
        itens_imoveis.append({
            'tipo': 'imovel', 'id': cod, 'sal': _sal(),
            **{k: i[k] for k in ('uf', 'municipio', 'area_ha', 'mod_fiscal', 'situacao', 'vigente', 'limites')},
            'versao_car': {'valido_de': i['valido_de'], 'hash': i['hash']},
            'status': veredito(r['status'] for r in linhas),
            'resultados': linhas,
        })
    status = veredito(i['status'] for i in itens_imoveis)
    resumo = {'tipo': 'resumo', 'id': 'resumo', 'sal': _sal(), 'status': status,
              'contagem': {s: sum(i['status'] == s for i in itens_imoveis) for s in GRAVIDADE}, 'imoveis': len(itens_imoveis)}

    # Número e instante por último: a linha da série fica travada só até o fim desta transação, e o instante acompanha a
    # ordem dos números.
    serie, numero = relatorios.proximo_numero(con)
    if corrigido and corrigido['serie'] != serie:
        raise PedidoInvalido(f'Report {substitui} belongs to another series (database restored or reset): it cannot be corrected in this one')
    emitido = datetime.now(timezone.utc).replace(microsecond=0)
    rid = f'NT-{emitido:%Y}-{numero:06d}'
    cabecalho = {
        'tipo': 'cabecalho', 'id': 'cabecalho', 'formato': documento.FORMATO, 'relatorio': rid, 'serie': serie, 'numero': numero,
        'emitido_em': emitido, 'emissor': None, 'regras': documento.regras_do_relatorio(),
        'bases': b.do_relatorio({f for a in escolhidas for f in a.fontes}, {i['uf'] for i in itens_imoveis}),
        'analises': [{'id': a.id, 'nome': a.nome, 'descricao': a.descricao, 'base': textos_bases[a.id]} for a in escolhidas],
        'substitui': {'relatorio': substitui, 'numero': corrigido['numero'], 'motivo': motivo} if corrigido else None,
    }
    # Pelos modelos, as folhas guardadas são JSON puro (datas em ISO 8601) e têm sempre as mesmas chaves.
    itens = [ItemCabecalho.model_validate(cabecalho).model_dump(mode='json'),
             ItemResumo.model_validate(resumo).model_dump(mode='json'),
             *(ItemImovel.model_validate(i).model_dump(mode='json') for i in itens_imoveis)]
    try:
        relatorios.gravar(con, id_=rid, serie=serie, numero=numero, emitido_em=emitido, cods=cods, analises=[a.id for a in escolhidas],
                          status=status, regras=VERSAO_REGRAS, substitui=substitui, motivo=motivo, texto=documento.texto(itens),
                          raiz=documento.raiz(itens))
    except UniqueViolation as e:
        # Duas correções do mesmo relatório ao mesmo tempo: a segunda esbarra no UNIQUE (substitui).
        raise Conflito(f'Report {substitui} was just superseded by another report: correct that one instead') from e
    return carregar(con, rid)


def carregar(con: Connection, rid: str) -> dict:
    """O relatório para ler (dominio/relatorio.visao), com a raiz registrada, `integro` (a raiz recalculada das folhas
    guardadas confere com ela), o registro na rede e o relatório que o substitui."""
    r = relatorios.guardado(con, rid)
    if not r:
        raise NaoEncontrado(f'Report {rid} not found')
    itens = documento.ler(r['documento'])
    return {
        **documento.visao(itens),
        'raiz': r['raiz'],
        'integro': documento.raiz(itens) == r['raiz'],
        'ancoragem': {c: r[f'a_{c}'] for c in relatorios.COLUNAS_ANCORAGEM},
        'substituido_por': ({'relatorio': r['s_relatorio'], 'emitido_em': r['s_emitido_em'], 'motivo': r['s_motivo']}
                            if r['s_relatorio'] else None),
    }


def documento_guardado(con: Connection, rid: str) -> str:
    """O documento exatamente como guardado: `{"itens": [...]}` em JCS."""
    r = relatorios.guardado(con, rid)
    if not r:
        raise NaoEncontrado(f'Report {rid} not found')
    return r['documento']


def prova(con: Connection, rid: str, cods: list[str], com_resumo: bool) -> dict:
    """Pacote de prova parcial do relatório (dominio/relatorio.prova)."""
    itens = documento.ler(documento_guardado(con, rid))
    try:
        return documento.prova(itens, [c.strip().upper() for c in cods if c.strip()], com_resumo)
    except KeyError as e:
        raise PedidoInvalido(f'Properties not in report {rid}: {e.args[0]}') from None
