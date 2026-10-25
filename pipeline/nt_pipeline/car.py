"""Carga do CAR (tema Área do Imóvel do SICAR), com histórico, de uma UF ou de todas.

Os arquivos de cada UF ficam em /dados/AREA_IMOVEL/<UF>/ (AREA_IMOVEL_1.shp, AREA_IMOVEL_2.shp…, ou os .zip baixados do
SICAR, sem descompactar): quando o SICAR divide o estado em partes, todas entram numa carga só. Cada carga compara o
estado inteiro com as versões vigentes: imóveis novos ou alterados ganham uma linha nova; versões substituídas e imóveis
que sumiram têm `valido_ate` fechado. Recarregar os mesmos arquivos não cria versões. Na mesma transação, cruza os imóveis
que mudaram com os alertas do MapBiomas e refaz a ficha já calculada deles (`ref.car_resumo`).

Sem UF, carrega todas as pastas, várias ao mesmo tempo: cada UF tem partição, staging e trava próprias.
"""

import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

from .banco import conectar, dsn_gdal, travar_uf
from .municipios import carregar_municipios
from .ufs import CODIGO_UF, validar_uf


PASTA_CAR = Path('/dados/AREA_IMOVEL')
#: UFs carregadas ao mesmo tempo. Cada uma ocupa um ogr2ogr e uma conexão; acima disso o disco vira o gargalo.
PARALELO = 4
#: Coordenadas fora disso não são latitude e longitude (ex.: polígono em UTM declarado em graus) e quebram a
#: projeção para o mapa: o imóvel fica de fora da carga, contado em `descartados`.
VALIDA = 'ST_MakeEnvelope(-180, -90, 180, 90, 4326)'


def _log(uf: str, msg: str) -> None:
    print(f'[{uf}] {msg}', flush=True)


def _parte(arquivo: Path) -> tuple[int, str]:
    # AREA_IMOVEL_2 antes de AREA_IMOVEL_10.
    n = re.search(r'(\d+)$', arquivo.stem)
    return (int(n.group(1)) if n else 0, arquivo.name)


def _pasta_da_uf(uf: str, pasta: Path) -> Path:
    return next((p for p in pasta.iterdir() if p.is_dir() and p.name.upper() == uf), pasta / uf) if pasta.is_dir() else pasta / uf


def _arquivos(dir_uf: Path) -> list[Path]:
    # Descompactados têm preferência: um .zip ao lado do próprio conteúdo não entra duas vezes.
    soltos = [*dir_uf.glob('*.shp'), *dir_uf.glob('*.gpkg')]
    return sorted(soltos or dir_uf.glob('*.zip'), key=_parte)


def arquivos_da_uf(uf: str, pasta: Path = PASTA_CAR) -> list[Path]:
    """Partes do CAR de uma UF, em ordem: shapefiles (ou GeoPackages, ou os .zip do SICAR) da pasta da UF."""
    dir_uf = _pasta_da_uf(uf, pasta)
    arquivos = _arquivos(dir_uf) if dir_uf.is_dir() else []
    if not arquivos:
        raise SystemExit(f'nenhum shapefile do CAR de {uf} em {dir_uf} (ver dados/README.md)')
    return arquivos


def ufs_disponiveis(pasta: Path = PASTA_CAR) -> list[str]:
    """UFs com pasta própria e algum arquivo do CAR, em ordem alfabética."""
    if not pasta.is_dir():
        return []
    return sorted(p.name.upper() for p in pasta.iterdir() if p.is_dir() and p.name.upper() in CODIGO_UF and _arquivos(p))


def _gdal(arquivo: str) -> str:
    # O GDAL lê o shapefile de dentro do .zip do SICAR sem extrair.
    return f'/vsizip/{arquivo}' if arquivo.lower().endswith('.zip') else arquivo


def _importar(arquivo: str, staging: str, anexar: bool = False) -> None:
    # SICAR publica o .dbf em latin-1 e sem .cpg; o GDAL precisa ser avisado.
    subprocess.run(
        [
            'ogr2ogr', '-f', 'PostgreSQL', dsn_gdal(), _gdal(arquivo),
            # A primeira parte recria a tabela de staging; as demais entram nela.
            '-nln', staging, *(['-append', '-update'] if anexar else ['-overwrite']),
            '-nlt', 'PROMOTE_TO_MULTI', '-t_srs', 'EPSG:4326', '-makevalid',
            # Staging é descartável: sem WAL, sem índice espacial.
            '-lco', 'GEOMETRY_NAME=geom', '-lco', 'SPATIAL_INDEX=NONE', '-lco', 'FID=fid', '-lco', 'UNLOGGED=ON',
            # O .dbf declara numeric(33,31), que estoura no Postgres; float8 basta para área e módulos.
            '-lco', 'PRECISION=NO',
            '-gt', '65536', '--config', 'PG_USE_COPY', 'YES', '--config', 'SHAPE_ENCODING', 'LATIN1',
        ],
        check=True,
    )


def carregar_car(ufs: list[str] | None, arquivos: list[str] | None, publicado_em: date | None = None, paralelo: int = PARALELO) -> None:
    """`ufs`: as UFs a carregar; sem elas, todas as que têm pasta em /dados/AREA_IMOVEL/.
    `arquivos`: as partes do estado (só com uma UF); sem elas, as da pasta da UF.
    `publicado_em`: a data de publicação dos arquivos no SICAR, se conhecida (ver _datas)."""
    ufs = [validar_uf(u) for u in ufs] if ufs else ufs_disponiveis()
    if not ufs:
        raise SystemExit(f'nenhuma UF com arquivos do CAR em {PASTA_CAR}/<UF>/ (ver dados/README.md)')
    if arquivos and len(ufs) > 1:
        raise SystemExit('--arquivo vale para uma UF só')
    # Confere os arquivos de todas antes de começar; as maiores primeiro, para as pequenas preencherem o fim.
    partes = {uf: arquivos or [str(a) for a in arquivos_da_uf(uf)] for uf in ufs}
    ufs = sorted(ufs, key=lambda uf: -sum(Path(a).stat().st_size for a in partes[uf] if Path(a).exists()))
    _preparar(ufs)

    t0 = time.time()
    falhas: dict[str, Exception] = {}
    with ThreadPoolExecutor(max_workers=max(1, min(paralelo, len(ufs)))) as ex:
        tarefas = {ex.submit(_carregar_uf, uf, partes[uf], publicado_em): uf for uf in ufs}
        for t in as_completed(tarefas):
            if erro := t.exception():
                falhas[tarefas[t]] = erro
                # O comando do ogr2ogr leva a senha do banco: basta o código de saída (o erro dele já saiu acima).
                motivo = f'ogr2ogr saiu com código {erro.returncode}' if isinstance(erro, subprocess.CalledProcessError) else erro
                _log(tarefas[t], f'falhou: {motivo}')
    if len(ufs) > 1:
        print(f'{len(ufs) - len(falhas)} de {len(ufs)} UFs carregadas em {time.time() - t0:.0f}s', flush=True)
    if falhas:
        raise SystemExit(f'falharam: {", ".join(sorted(falhas))}')


def _preparar(ufs: list[str]) -> None:
    """Antes das cargas paralelas: partições que faltam e municípios do IBGE das UFs que ainda não os têm.
    Criar a partição trava a tabela-mãe; com uma carga em andamento, ficaria esperando ela terminar."""
    with conectar() as con:
        for uf in ufs:
            con.execute(f"CREATE TABLE IF NOT EXISTS ref.car_imovel_{uf.lower()} PARTITION OF ref.car_imovel FOR VALUES IN ('{uf}')")
        con.commit()
        com_municipios = {r[0] for r in con.execute('SELECT DISTINCT uf FROM ref.municipio WHERE uf = ANY(%s)', (ufs,))}
    for uf in ufs:
        if uf not in com_municipios:
            try:
                carregar_municipios(uf)
            except Exception as e:  # o CAR não depende deles: segue sem os nomes oficiais
                _log(uf, f'municípios do IBGE não carregados ({e}); rode `municipios --uf {uf}` depois')


def _carregar_uf(uf: str, arquivos: list[str], publicado_em: date | None) -> None:
    staging = f'ref.stg_car_{uf.lower()}'
    with travar_uf(uf):
        try:
            _carregar(uf, arquivos, publicado_em, staging)
        finally:
            # Uma carga que falhou não deixa o staging (centenas de MB) para trás.
            with conectar(autocommit=True) as con:
                con.execute(f'DROP TABLE IF EXISTS {staging}')


def _datas(con, uf: str, publicado_em: date | None) -> tuple[date | None, date]:
    """(dados_ate, data de referência) da carga. `dados_ate` sai do arquivo: a atualização mais recente de um imóvel
    (data depois de hoje não conta, é erro na origem). A data de referência é a de publicação, se informada, ou essa;
    ela vira o valido_de/valido_ate das versões e não pode ser anterior à da última carga da UF."""
    dados_ate = con.execute('SELECT max(atualizado_sicar) FROM novo WHERE atualizado_sicar <= current_date').fetchone()[0]
    data_ref = publicado_em or dados_ate
    if data_ref is None:
        raise SystemExit(f'[{uf}] nenhum imóvel com data de atualização (dat_atuali) no arquivo: informe --publicado-em')
    ultima = con.execute('SELECT max(data_referencia) FROM ref.car_carga WHERE uf = %s', (uf,)).fetchone()[0]
    if ultima and data_ref < ultima:
        origem = 'publicação informada' if publicado_em else 'atualização mais recente no arquivo'
        raise SystemExit(f'[{uf}] a carga é de {data_ref:%d/%m/%Y} ({origem}), anterior à última carga da UF '
                         f'({ultima:%d/%m/%Y}): o histórico das versões ficaria fora de ordem. Se o arquivo é mais novo, '
                         'informe a data de publicação com --publicado-em.')
    return dados_ate, data_ref


def _carregar(uf: str, arquivos: list[str], publicado_em: date | None, staging: str) -> None:
    t0 = time.time()
    for k, parte in enumerate(arquivos):
        _log(uf, f'importando {parte} ({k + 1}/{len(arquivos)})…')
        _importar(parte, staging, anexar=k > 0)
    _log(uf, f'importado em {time.time() - t0:.0f}s')

    with conectar() as con:
        descartados = [r[0] for r in con.execute(
            f'SELECT cod_imovel FROM {staging} WHERE cod_imovel IS NOT NULL AND NOT ST_IsEmpty(geom) AND NOT geom @ {VALIDA}')]
        if descartados:
            _log(uf, f'{len(descartados)} imóvel(is) com coordenadas fora de latitude/longitude, fora da carga: {", ".join(descartados[:20])}')

        # Normaliza: um registro por código (o mais recente), atributos tipados e hash da versão, numa passada só.
        # O hash não pode mudar de fórmula: senão a próxima carga vê todo imóvel como alterado.
        con.execute(f"""
            CREATE TEMP TABLE novo ON COMMIT DROP AS
            SELECT *, decode(md5(concat_ws('|', status, tipo, condicao, area_ha, mod_fiscal, atualizado_sicar,
                                           encode(ST_AsBinary(geom), 'hex'))), 'hex') AS hash
            FROM (
                SELECT DISTINCT ON (cod_imovel)
                       cod_imovel,
                       nullif(split_part(cod_imovel, '-', 2), '')::int AS cod_ibge,
                       municipio,
                       num_area::float8 AS area_ha,
                       mod_fiscal::float8 AS mod_fiscal,
                       ind_status AS status,
                       ind_tipo AS tipo,
                       des_condic AS condicao,
                       to_date(nullif(dat_criaca, ''), 'DD/MM/YYYY') AS criado_sicar,
                       to_date(nullif(dat_atuali, ''), 'DD/MM/YYYY') AS atualizado_sicar,
                       ST_Multi(ST_CollectionExtract(geom, 3))::geometry(MultiPolygon, 4326) AS geom
                FROM {staging}
                WHERE cod_imovel IS NOT NULL AND NOT ST_IsEmpty(geom) AND geom @ {VALIDA}
                -- Códigos repetidos no arquivo: fica o registro atualizado por último; empate, o último do arquivo.
                -- A escolha precisa ser determinística, senão recarregar o mesmo arquivo cria versões falsas.
                ORDER BY cod_imovel, to_date(nullif(dat_atuali, ''), 'DD/MM/YYYY') DESC NULLS LAST, fid DESC
            ) x
        """)
        # Tabela temporária não passa pelo autovacuum: sem ANALYZE, o planejador não sabe o tamanho dela.
        con.execute('CREATE INDEX ON novo (cod_imovel); ANALYZE novo')
        registros = con.execute('SELECT count(*) FROM novo').fetchone()[0]
        dados_ate, data_ref = _datas(con, uf, publicado_em)
        _log(uf, f'{registros} imóveis no arquivo, atualizados até {dados_ate or "?"}; data de referência {data_ref}')
        carga = con.execute(
            'INSERT INTO ref.car_carga (uf, arquivo, data_referencia, dados_ate, publicado_em) VALUES (%s, %s, %s, %s, %s) RETURNING id',
            (uf, ', '.join(arquivos), data_ref, dados_ate, publicado_em),
        ).fetchone()[0]

        # Fecha versões que mudaram ou sumiram.
        alterados_ou_removidos = con.execute("""
            UPDATE ref.car_imovel v SET valido_ate = %s
            WHERE v.uf = %s AND v.valido_ate IS NULL
              AND NOT EXISTS (SELECT 1 FROM novo n WHERE n.cod_imovel = v.cod_imovel AND n.hash = v.hash)
            RETURNING cod_imovel
        """, (data_ref, uf)).fetchall()
        fechados = {r[0] for r in alterados_ou_removidos}

        # Só o que não tem versão vigente idêntica vira linha nova.
        con.execute("""
            DELETE FROM novo n USING ref.car_imovel v
            WHERE v.uf = %s AND v.valido_ate IS NULL AND v.cod_imovel = n.cod_imovel
        """, (uf,))
        inseridos = con.execute("""
            INSERT INTO ref.car_imovel (uf, cod_imovel, cod_ibge, municipio, area_ha, mod_fiscal, status, tipo, condicao,
                                        criado_sicar, atualizado_sicar, hash, geom, geom_3857, carga_id, valido_de)
            SELECT %s, cod_imovel, cod_ibge, municipio, area_ha, mod_fiscal, status, tipo, condicao,
                   criado_sicar, atualizado_sicar, hash, geom, ST_Transform(geom, 3857), %s, %s
            FROM novo
            RETURNING cod_imovel
        """, (uf, carga, data_ref)).fetchall()
        novos = {r[0] for r in inseridos}
        alterados = len(fechados & novos)
        con.execute(
            'UPDATE ref.car_carga SET registros = %s, inseridos = %s, alterados = %s, removidos = %s, descartados = %s WHERE id = %s',
            (registros, len(novos) - alterados, alterados, len(fechados) - alterados, len(descartados), carga),
        )
        # Alertas do MapBiomas sobre os imóveis novos ou alterados; os removidos ficam com os da última versão.
        pares = con.execute("SELECT ref.cruzar_car_alerta(ref.camada_vigente('mapbiomas'), %s, %s)", (uf, carga)).fetchone()[0]
        # A ficha já calculada dos imóveis que mudaram (ref.car_resumo), com os biomas e os alertas.
        fichas = con.execute('SELECT ref.atualizar_car_resumo(%s)', (uf,)).fetchone()[0]
        con.commit()
        _log(uf, f'carga {carga}: {len(novos) - alterados} novos, {alterados} alterados, {len(fechados) - alterados} removidos, '
                 f'{pares} pares alerta × imóvel, {fichas} fichas refeitas ({time.time() - t0:.0f}s)')

    with conectar(autocommit=True) as con:
        con.execute(f'ANALYZE ref.car_imovel_{uf.lower()}')
        con.execute('ANALYZE ref.car_resumo')
    _log(uf, f'pronto em {time.time() - t0:.0f}s')
