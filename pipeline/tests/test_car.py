"""Run with: docker compose run --rm --entrypoint python3 pipeline -m unittest discover -s tests -v"""

import tempfile
import unittest
from pathlib import Path

from nt_pipeline.car import arquivos_da_uf, ufs_disponiveis


class PastasDoCar(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _arquivos(self, uf: str, *nomes: str) -> None:
        (self.raiz / uf).mkdir()
        for n in nomes:
            (self.raiz / uf / n).touch()

    def test_partes_do_estado_em_ordem_numerica(self):
        self._arquivos('MG', 'AREA_IMOVEL_10.shp', 'AREA_IMOVEL_2.shp', 'AREA_IMOVEL_1.shp', 'AREA_IMOVEL_1.dbf')
        self.assertEqual([a.name for a in arquivos_da_uf('MG', self.raiz)],
                         ['AREA_IMOVEL_1.shp', 'AREA_IMOVEL_2.shp', 'AREA_IMOVEL_10.shp'])

    def test_ufs_com_arquivo_valido(self):
        self._arquivos('RS', 'AREA_IMOVEL_1.shp')
        self._arquivos('sc', 'AREA_IMOVEL_1.shp')  # pasta em minúsculas também vale
        self._arquivos('GO')  # pasta vazia não conta
        self._arquivos('XX', 'AREA_IMOVEL_1.shp')  # não é UF
        self.assertEqual(ufs_disponiveis(self.raiz), ['RS', 'SC'])
        self.assertEqual([a.name for a in arquivos_da_uf('SC', self.raiz)], ['AREA_IMOVEL_1.shp'])

    def test_zip_do_sicar_vale_sem_descompactar(self):
        self._arquivos('PA', 'AREA_IMOVEL_2.zip', 'AREA_IMOVEL_1.zip')
        self.assertEqual(ufs_disponiveis(self.raiz), ['PA'])
        self.assertEqual([a.name for a in arquivos_da_uf('PA', self.raiz)], ['AREA_IMOVEL_1.zip', 'AREA_IMOVEL_2.zip'])

    def test_descompactado_tem_preferencia_sobre_o_zip(self):
        self._arquivos('TO', 'AREA_IMOVEL_1.zip', 'AREA_IMOVEL_1.shp')
        self.assertEqual([a.name for a in arquivos_da_uf('TO', self.raiz)], ['AREA_IMOVEL_1.shp'])

    def test_uf_sem_arquivo_falha_com_mensagem(self):
        with self.assertRaises(SystemExit):
            arquivos_da_uf('GO', self.raiz)


if __name__ == '__main__':
    unittest.main()
