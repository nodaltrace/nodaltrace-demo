"""PDF do relatório de análise (ReportLab). Renderiza só o documento canônico guardado: nada é recalculado aqui."""

from __future__ import annotations

from datetime import datetime
from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Flowable, KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from ..dominio.conformidade import rotulo_situacao
from ..formato import BRASILIA, data as _data_texto, num as _num_texto

FONTES = Path(__file__).parents[1] / 'fontes'
for _nome, _arquivo in [('Titulo', 'Montserrat-SemiBold'), ('TituloMedio', 'Montserrat-Medium'), ('Corpo', 'Inter-Variable'),
                        ('Dado', 'JetBrainsMono-Variable')]:
    pdfmetrics.registerFont(TTFont(_nome, FONTES / f'{_arquivo}.ttf'))

INK = colors.HexColor('#092924')
FOREST = colors.HexColor('#3B604F')
SAGE = colors.HexColor('#7F9974')
GOLD = colors.HexColor('#CEB074')
LINHA = colors.HexColor('#D5DCD2')
FUNDO = colors.HexColor('#F4F4EC')

# Forma e cor de cada status (as do app); o texto usa um tom mais escuro, legível no papel.
STATUS = {
    'conforme': ('Compliant', 'circulo', '#8FB169', '#4F7A2E'),
    'atencao': ('Attention', 'triangulo', '#F3C465', '#9A6B00'),
    'nao_conforme': ('Non-compliant', 'losango', '#E5674F', '#B8391F'),
    'pendente': ('Pending', 'anel', '#9FB0AA', '#5F726B'),
    None: ('Informational', 'traco', '#9FB0AA', '#5F726B'),
}
#: Detalhes por análise no PDF; o restante fica no registro.
MAX_DETALHES = 15

_e = ParagraphStyle
S = {
    'etiqueta': _e('etiqueta', fontName='Titulo', fontSize=7.5, leading=10, textColor=FOREST, spaceAfter=2),
    'h1': _e('h1', fontName='Titulo', fontSize=19, leading=23, textColor=INK, spaceAfter=10),
    'h2': _e('h2', fontName='Titulo', fontSize=11, leading=14, textColor=INK, spaceBefore=14, spaceAfter=6, keepWithNext=1),
    'h3': _e('h3', fontName='Dado', fontSize=9.5, leading=12, textColor=INK),
    'corpo': _e('corpo', fontName='Corpo', fontSize=8.5, leading=11.5, textColor=INK),
    'peq': _e('peq', fontName='Corpo', fontSize=7.5, leading=10, textColor=FOREST),
    'rotulo': _e('rotulo', fontName='Titulo', fontSize=6.8, leading=9, textColor=SAGE),
    'valor': _e('valor', fontName='Corpo', fontSize=8.5, leading=11, textColor=INK),
    'dado': _e('dado', fontName='Dado', fontSize=7.5, leading=10, textColor=INK),
    'th': _e('th', fontName='Titulo', fontSize=7, leading=9, textColor=FOREST),
    'hash': _e('hash', fontName='Dado', fontSize=8, leading=11, textColor=INK),
}


def _p(texto: str, estilo: str = 'corpo', **kw) -> Paragraph:
    return Paragraph(escape(texto), _e(f'{estilo}-x', parent=S[estilo], **kw) if kw else S[estilo])


def _num(x: float | None, casas: int = 1) -> str:
    if x is None:
        return '–'
    return _num_texto(x, casas)


def _quando(v: str | datetime) -> str:
    d = (v if isinstance(v, datetime) else datetime.fromisoformat(v)).astimezone(BRASILIA)
    return f'{_data_texto(d.date())} at {d:%H:%M} (Brasília time)'


def _data(iso: str | None) -> str:
    return _data_texto(datetime.fromisoformat(iso).date()) if iso else '–'


def _dia(iso: str) -> str:
    """O dia de um instante, no horário de Brasília."""
    return _data_texto(datetime.fromisoformat(iso).astimezone(BRASILIA).date())


class Forma(Flowable):
    """A forma do status, como no app: a cor nunca é o único sinal."""

    def __init__(self, status: str | None, tam: float = 7.5):
        super().__init__()
        self.forma, self.cor = STATUS[status][1], colors.HexColor(STATUS[status][2])
        self.width = self.height = tam

    def draw(self):
        c, t = self.canv, self.width
        c.setFillColor(self.cor)
        c.setStrokeColor(self.cor)
        c.setLineWidth(1.4)
        if self.forma == 'circulo':
            c.circle(t / 2, t / 2, t / 2, stroke=0, fill=1)
        elif self.forma == 'anel':
            c.circle(t / 2, t / 2, t / 2 - 0.7, stroke=1, fill=0)
        elif self.forma == 'triangulo':
            p = c.beginPath()
            p.moveTo(0, 0), p.lineTo(t, 0), p.lineTo(t / 2, t), p.close()
            c.drawPath(p, stroke=0, fill=1)
        elif self.forma == 'losango':
            p = c.beginPath()
            p.moveTo(t / 2, 0), p.lineTo(t, t / 2), p.lineTo(t / 2, t), p.lineTo(0, t / 2), p.close()
            c.drawPath(p, stroke=0, fill=1)
        else:
            c.line(0, t / 2, t, t / 2)


def _selo(status: str | None, tam: float = 8, fonte: float = 8) -> Table:
    rotulo, _, _, texto = STATUS[status]
    t = Table([[Forma(status, tam), _p(rotulo, 'corpo', fontName='TituloMedio', fontSize=fonte, leading=fonte + 3, textColor=colors.HexColor(texto))]],
              colWidths=[tam + 4, None], hAlign='LEFT')
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                           ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0)]))
    return t


def _qr(texto: str, tam: float) -> Drawing:
    w = QrCodeWidget(texto, barLevel='M')
    x0, y0, x1, y1 = w.getBounds()
    d = Drawing(tam, tam, transform=[tam / (x1 - x0), 0, 0, tam / (y1 - y0), 0, 0])
    d.add(w)
    return d


def _caixa(linhas: list, largura: float, cor=GOLD) -> Table:
    """Caixa de destaque com a barra lateral (correção, substituição)."""
    t = Table([[x] for x in linhas], colWidths=[largura])
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), FUNDO), ('LINEBEFORE', (0, 0), (0, -1), 3, cor),
                           ('LEFTPADDING', (0, 0), (-1, -1), 10), ('TOPPADDING', (0, 0), (-1, 0), 7), ('BOTTOMPADDING', (0, -1), (-1, -1), 7)]))
    return t


def _tabela(linhas: list[list], larguras: list[float], cabecalho: bool = True, zebra: bool = False) -> Table:
    t = Table(linhas, colWidths=larguras, repeatRows=1 if cabecalho else 0, hAlign='LEFT')
    estilo = [
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 4.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 4.5),
        ('LINEBELOW', (0, 0), (-1, -1), 0.4, LINHA),
    ]
    if cabecalho:
        estilo += [('LINEBELOW', (0, 0), (-1, 0), 1, INK)]
    if zebra:
        estilo += [('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, FUNDO])]
    t.setStyle(TableStyle(estilo))
    return t


def _paginado(doc: dict):
    """Canvas que só desenha cabeçalho e rodapé depois de saber o total de páginas."""

    class Paginado(Canvas):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self._paginas = []

        def showPage(self):
            self._paginas.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._paginas)
            for estado in self._paginas:
                self.__dict__.update(estado)
                self._moldura(total)
                super().showPage()
            super().save()

        def _moldura(self, total: int):
            w, h = A4
            self.setFillColor(INK)
            self.setFont('Titulo', 12)
            self.drawString(18 * mm, h - 14 * mm, 'NodalTrace')
            self.setFont('Corpo', 7.5)
            self.setFillColor(FOREST)
            self.drawRightString(w - 18 * mm, h - 14 * mm, f'Analysis report · {doc["id"]}')
            self.setStrokeColor(GOLD)
            self.setLineWidth(1.2)
            self.line(18 * mm, h - 17 * mm, w - 18 * mm, h - 17 * mm)
            self.setStrokeColor(LINHA)
            self.setLineWidth(0.5)
            self.line(18 * mm, 15 * mm, w - 18 * mm, 15 * mm)
            self.setFont('Dado', 6.5)
            self.setFillColor(FOREST)
            self.drawString(18 * mm, 10.5 * mm, f'Merkle root {doc["raiz"]}')
            self.setFont('Corpo', 7)
            self.drawRightString(w - 18 * mm, 10.5 * mm, f'Page {self._pageNumber} of {total}')

    return Paginado


def pdf_relatorio(doc: dict, rede: dict | None = None, url_verificacao: str | None = None) -> bytes:
    """O PDF do relatório guardado (emissao.carregar): a renderização do registro, com a raiz de Merkle em cada página e o
    registro na Solana como estava no momento do download. `rede`: onde conferir (solana.rede()); `url_verificacao`: a
    página de verificação do relatório, que vai também num QR code."""
    buf = BytesIO()
    largura = A4[0] - 36 * mm
    pdf = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=24 * mm, bottomMargin=22 * mm,
                            title=f'Analysis report {doc["id"]}', author='NodalTrace', subject='Socio-environmental analysis of CAR properties')
    nomes = {a['id']: a['nome'] for a in doc['analises']}
    imoveis = doc['imoveis']
    emissor = doc['emissor'] or {}
    r = doc['resumo']
    f: list = []

    # --- identificação ---
    f += [_p('SOCIO-ENVIRONMENTAL ANALYSIS REPORT', 'etiqueta'), _p('Analysis of CAR rural properties', 'h1')]
    meta = [
        ('Number', doc['id']), ('Issued on', _quando(doc['emitido_em'])),
        ('Company', emissor.get('empresa') or 'Not reported'), ('Analyst', ' · '.join(x for x in (emissor.get('analista'), emissor.get('cargo')) if x) or 'Not reported'),
        ('Properties analyzed', str(len(imoveis))), ('Analyses applied', str(len(doc['analises']))),
    ]
    celulas = [[_p(rot, 'rotulo'), _p(val, 'dado' if rot == 'Number' else 'valor')] for rot, val in meta]
    grade = [celulas[i] + celulas[i + 1] for i in range(0, len(celulas), 2)]
    t = Table(grade, colWidths=[28 * mm, largura / 2 - 28 * mm] * 2, hAlign='LEFT')
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 5)]))
    f.append(t)

    # --- correção ---
    if s := doc.get('substitui'):
        f += [Spacer(1, 6), _caixa([_p('CORRECTION', 'rotulo'),
                                    _p(f'This report corrects {s["relatorio"]} (number {s["numero"]}). Reason: {s["motivo"]}')], largura)]
    if sp := doc.get('substituido_por'):
        f += [Spacer(1, 6), _caixa([
            _p('SUPERSEDED', 'rotulo', textColor=colors.HexColor(STATUS['nao_conforme'][3])),
            _p(f'This report was superseded by {sp["relatorio"]}, issued on {_quando(sp["emitido_em"])}. Reason: {sp["motivo"]}'),
            _p('Information as of this PDF, from the corrections record: it is not part of the document registered on Solana.', 'peq'),
        ], largura, colors.HexColor(STATUS['nao_conforme'][2]))]

    # --- resultado geral ---
    partes = [(r['nao_conforme'], 'non-compliant'), (r['atencao'], 'needing attention'), (r['pendente'], 'pending'), (r['conforme'], 'compliant')]
    texto = f'{len(imoveis)} {"property" if len(imoveis) == 1 else "properties"}: ' + ' · '.join(f'{n} {rotulo}' for n, rotulo in partes if n)
    caixa = Table([[_p('OVERALL RESULT', 'rotulo')], [_selo(doc['status'], 11, 13)],
                   [_p(f'{texto}. The overall result is the worst among the properties; each property\'s result is the worst among the analyses '
                       'that issue a verdict.', 'peq')]],
                  colWidths=[largura])
    caixa.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), FUNDO), ('LINEBEFORE', (0, 0), (0, -1), 3, GOLD),
                               ('LEFTPADDING', (0, 0), (-1, -1), 10), ('TOPPADDING', (0, 0), (-1, 0), 8), ('BOTTOMPADDING', (0, -1), (-1, -1), 8)]))
    f += [Spacer(1, 8), caixa]

    # --- análises aplicadas ---
    f.append(_p('Analyses applied', 'h2'))
    f.append(_tabela(
        [[_p('Analysis', 'th'), _p('Criterion', 'th'), _p('Data source', 'th')]]
        + [[_p(a['nome'], 'corpo', fontName='TituloMedio'), _p(a['descricao'], 'peq'), _p(a['base'], 'peq')] for a in doc['analises']],
        [38 * mm, (largura - 38 * mm) * 0.52, (largura - 38 * mm) * 0.48],
    ))

    # --- bases de dados e as datas delas ---
    f.append(_p('Data sources', 'h2'))
    f.append(_tabela(
        [[_p('Source', 'th'), _p('Data through', 'th'), _p('Published at source', 'th'), _p('Loaded on', 'th')]]
        + [[_p(' · '.join(x for x in (b['nome'], b['uf'], b['versao']) if x), 'corpo'), _p(_data(b['dados_ate']), 'dado'),
            _p(_data(b['publicado_em']) if b['publicado_em'] else 'not reported', 'dado' if b['publicado_em'] else 'peq'),
            _p(_dia(b['carregado_em']), 'dado')] for b in doc['bases']],
        [largura - 3 * 34 * mm, 34 * mm, 34 * mm, 34 * mm],
    ))
    f.append(Spacer(1, 4))
    f.append(_p(f'The report was issued on {_dia(doc["emitido_em"])}; the data run up to the date under “Data through”, taken from '
                'the data itself: in SICAR, the most recent property update in the file; in MapBiomas, the most recently detected '
                'alert. “Published at source” is the date the source published the dataset, when given at load time; “Loaded on” '
                'is when it entered NodalTrace.', 'peq'))

    # --- quadro dos imóveis ---
    f.append(_p('Properties analyzed', 'h2'))
    f.append(_tabela(
        [[_p('#', 'th'), _p('CAR code', 'th'), _p('Municipality', 'th'), _p('Area', 'th', alignment=TA_RIGHT), _p('Result', 'th')]]
        + [[_p(str(n), 'peq'), _p(i['cod_imovel'], 'dado', fontSize=6.8), _p(f'{i["municipio"]} · {i["uf"]}', 'corpo'),
            _p(f'{_num(i["area_ha"])} ha', 'corpo', alignment=TA_RIGHT), _selo(i['status'])]
           for n, i in enumerate(imoveis, 1)],
        [7 * mm, 70 * mm, largura - 7 * mm - 70 * mm - 22 * mm - 31 * mm, 22 * mm, 31 * mm], zebra=True,
    ))

    # --- detalhe por imóvel ---
    for n, i in enumerate(imoveis, 1):
        v = i['versao_car']
        ficha = (f'{i["municipio"]} · {i["uf"]} · {_num(i["area_ha"])} ha · {_num(i["mod_fiscal"])} fiscal modules · '
                 f'CAR {rotulo_situacao(i["situacao"]).lower()}{"" if i["vigente"] else " (missing from the latest SICAR data load)"} · '
                 f'version in the database since {_data(v["valido_de"])}')
        topo = Table([[_p(f'{n}. {i["cod_imovel"]}', 'h3'), _selo(i['status'], 9, 9)]], colWidths=[largura - 34 * mm, 34 * mm])
        topo.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('LINEBELOW', (0, 0), (-1, -1), 1, INK)]))
        linhas = [[_p('Analysis', 'th'), _p('Result', 'th'), _p('Finding', 'th')]]
        for res in i['resultados']:
            constat = [_p(res['resumo'])]
            detalhes = res['detalhes']
            constat += [_p(f'• {d}', 'peq') for d in detalhes[:MAX_DETALHES]]
            if len(detalhes) > MAX_DETALHES:
                constat.append(_p(f'• and {len(detalhes) - MAX_DETALHES} more items in record {doc["id"]}', 'peq'))
            linhas.append([_p(nomes[res['analise']], 'corpo', fontName='TituloMedio'), _selo(res['status']), constat])
        # O título da seção vai junto do primeiro imóvel, para não ficar sozinho no pé da página.
        bloco = [*([_p('Results by property', 'h2')] if n == 1 else []), Spacer(1, 6), topo, Spacer(1, 3), _p(ficha, 'peq'), _p(f'CAR version hash: {v["hash"]}', 'peq', fontName='Dado', fontSize=6.5), Spacer(1, 4)]
        # Ficha e tabela na mesma página quando cabem; o ReportLab quebra o bloco se ele passar de uma página.
        f += [KeepTogether([*bloco, _tabela(linhas, [36 * mm, 31 * mm, largura - 67 * mm])]), Spacer(1, 6)]

    # --- registro na Solana ---
    a = doc['ancoragem']
    rede = rede or {}
    cluster = a.get('cluster') or rede.get('cluster') or 'devnet'
    registro = [
        ('Report', f'{doc["id"]} · number {doc["numero"]} in series {doc["serie"]}'),
        ('Network', f'Solana {cluster}' + (' (Solana\'s test network, which does not guarantee to keep its history)' if cluster == 'devnet' else '')),
        ('NodalTrace authority', rede.get('autoridade') or 'not reported'),
        ('Credential', rede.get('credencial') or 'not reported'),
        ('Rules version', doc['regras']['versao']),
    ]
    if a['status'] == 'confirmada':
        registro += [('Registered on', _quando(a['bloco_em']) if a.get('bloco_em') else 'confirmed'), ('On-chain account', a['conta']),
                     ('Transaction', a['transacao'] or '–')]
    elif a['status'] == 'falhou':
        registro.append(('Registration', 'rejected by the network: under review'))
    else:
        registro.append(('Registration', 'not yet confirmed when this PDF was generated (it happens right after issuance): check the '
                                         'Verification page'))
    dados = Table([[_p(rot, 'rotulo'), _p(str(val), 'dado' if rot in ('NodalTrace authority', 'Credential', 'On-chain account', 'Transaction') else 'valor')]
                   for rot, val in registro], colWidths=[34 * mm, largura - 34 * mm - (36 * mm if url_verificacao else 0)], hAlign='LEFT')
    dados.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 4)]))
    if url_verificacao:
        qr = Table([[_qr(url_verificacao, 30 * mm)], [_p('Verification page', 'peq', alignment=1)]], colWidths=[36 * mm])
        qr.setStyle(TableStyle([('ALIGN', (0, 0), (-1, -1), 'CENTER'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0)]))
        dados = Table([[dados, qr]], colWidths=[largura - 36 * mm, 36 * mm], hAlign='LEFT')
        dados.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0)]))
    f.append(KeepTogether([
        _p('Solana registration', 'h2'),
        _p(f'The Merkle root below summarizes the entire content of record {doc["id"]}: the properties, the version of each CAR analyzed, '
           'the data sources with their dates, the rules version and all results. Right after issuance, it is written to Solana by the '
           'NodalTrace credential, where it can no longer be changed or deleted. Anyone holding the report document (JSON) can recompute '
           'the root and check it against the network on the Verification page: any change to the content changes the root.'),
        Spacer(1, 4),
        _p(doc['raiz'], 'hash', backColor=FUNDO, borderPadding=5),
        Spacer(1, 8),
        dados,
        *([_p(url_verificacao, 'peq', fontName='Dado')] if url_verificacao else []),
        Spacer(1, 8),
        _p('The results reflect the data sources listed, with data up to the dates in the “Data sources” table, not the state of '
           'the sources on the issue date. “Attention” and “Pending” require review by an analyst before any decision; '
           '“Informational” does not count toward the verdict.', 'peq'),
    ]))

    pdf.build(f, canvasmaker=_paginado(doc))
    return buf.getvalue()
