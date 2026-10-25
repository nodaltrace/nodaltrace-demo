import argparse
from datetime import date

from .biomas import carregar_biomas
from .car import PARALELO, carregar_car, ufs_disponiveis
from .limpar import limpar
from .mapbiomas import carregar_mapbiomas
from .migrar import migrar
from .municipios import carregar_municipios


def main() -> None:
    p = argparse.ArgumentParser(prog='nt_pipeline', description='Ingestão de dados da NodalTrace')
    sub = p.add_subparsers(dest='comando', required=True)
    sub.add_parser('migrar', help='aplica as migrações de /db')

    m = sub.add_parser('municipios', help='carrega a malha municipal do IBGE de uma UF')
    m.add_argument('--uf', required=True)

    c = sub.add_parser('car', help='carrega o CAR (Área do Imóvel) de uma ou mais UFs, guardando o histórico')
    c.add_argument('--uf', nargs='+', help='UFs a carregar; padrão: todas as pastas de /dados/AREA_IMOVEL/<UF>/')
    c.add_argument('--arquivo', nargs='+', help='partes do estado (shapefile, GeoPackage ou .zip do SICAR, caminhos no '
                                               'contêiner), com uma UF só; padrão: todas as da pasta da UF')
    c.add_argument('--publicado-em', type=date.fromisoformat,
                   help='data de publicação (ou de download) do arquivo no SICAR, AAAA-MM-DD; sem ela, a carga vale pela '
                        'atualização mais recente de um imóvel no arquivo')
    c.add_argument('--paralelo', type=int, default=PARALELO, help=f'UFs carregadas ao mesmo tempo (padrão: {PARALELO})')

    mb = sub.add_parser('mapbiomas', help='carrega os alertas do MapBiomas Alerta e os cruza com o CAR carregado')
    mb.add_argument('--alertas', required=True, help='shapefile alerts_with_intersections, caminho no contêiner')
    mb.add_argument('--publicado-em', type=date.fromisoformat,
                    help='data de publicação (ou de download) do arquivo no MapBiomas, AAAA-MM-DD; sem ela, a camada vale '
                         'pela detecção mais recente do arquivo')

    bi = sub.add_parser('biomas', help='carrega os biomas do IBGE (Biomas e Sistema Costeiro-Marinho do Brasil, 1:250.000)')
    bi.add_argument('--arquivo', required=True, help='shapefile dos biomas, caminho no contêiner')
    bi.add_argument('--edicao', default='2025', help='edição do mapa do IBGE (vai para a referência das análises)')

    sub.add_parser('ufs-car', help='lista as UFs com arquivos do CAR em /dados/AREA_IMOVEL/<UF>/')
    sub.add_parser('limpar', help='apaga as referências carregadas e as operações geradas, voltando ao banco recém-migrado')

    args = p.parse_args()
    if args.comando == 'migrar':
        migrar()
    elif args.comando == 'municipios':
        carregar_municipios(args.uf)
    elif args.comando == 'car':
        carregar_car(args.uf, args.arquivo, args.publicado_em, args.paralelo)
    elif args.comando == 'mapbiomas':
        carregar_mapbiomas(args.alertas, args.publicado_em)
    elif args.comando == 'biomas':
        carregar_biomas(args.arquivo, args.edicao)
    elif args.comando == 'ufs-car':
        print(' '.join(ufs_disponiveis()))
    elif args.comando == 'limpar':
        limpar()


if __name__ == '__main__':
    main()
