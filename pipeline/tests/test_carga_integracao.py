"""Integração das cargas: o que a pipeline deixou no banco de testes montado por tests/preparar_banco_teste.sh, com a
amostra de dados reais de tests/dados/ (papéis dos imóveis e contagens esperadas em casos.json). Pula sem
NT_BANCO_TESTE=1; recusa rodar num banco cujo nome não termine em _teste.

Roda com o ./run.sh test ou, depois do tests/preparar_banco_teste.sh:
DADOS_DIR=./tests/dados docker compose run --rm -T -e NT_BANCO_TESTE=1 \\
  -e DATABASE_URL=postgresql://nodaltrace:nodaltrace@db:5432/nodaltrace_teste \\
  --entrypoint python3 pipeline -m unittest tests.test_carga_integracao -v
"""

import json
import os
import subprocess
import sys
import unittest
from datetime import date
from pathlib import Path

from nt_pipeline.banco import conectar

#: A amostra montada em /dados (DADOS_DIR=./tests/dados).
CASOS = Path('/dados/casos.json')
#: O corte da EUDR de dominio/conformidade.py (tests/test_paridade.py confere o das funções do banco).
CORTE_EUDR = date(2020, 12, 31)
CARGA_2 = '/dados/carga2/AREA_IMOVEL/RS/AREA_IMOVEL_1.shp'


@unittest.skipUnless(os.environ.get('NT_BANCO_TESTE') == '1', 'sem NT_BANCO_TESTE=1 (banco de testes: tests/preparar_banco_teste.sh)')
class CargaDaAmostra(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not CASOS.is_file():
            raise RuntimeError(f'{CASOS} não existe: rode com DADOS_DIR=./tests/dados')
        cls.casos = json.loads(CASOS.read_text())
        cls.esperado = cls.casos['esperado']
        cls.imoveis = cls.casos['imoveis']
        cls.datas = {k: date.fromisoformat(v) for k, v in cls.casos['datas'].items()}
        with conectar() as con:
            banco = con.execute('SELECT current_database()').fetchone()[0]
        # O teste recarrega o CAR: nunca no banco de desenvolvimento.
        if not banco.endswith('_teste'):
            raise RuntimeError(f'DATABASE_URL aponta para {banco}, não para um banco de testes (*_teste)')

    def _linhas(self, sql: str, *params):
        with conectar() as con:
            return con.execute(sql, params).fetchall()

    def _versoes(self, cod: str):
        return self._linhas("""
            SELECT status, condicao, atualizado_sicar, valido_de, valido_ate FROM ref.car_imovel
            WHERE cod_imovel = %s ORDER BY valido_de, id""", cod)

    def _pares(self):
        return self._linhas('SELECT cod_imovel, alerta, detectado_em, area_ha FROM ref.car_alerta ORDER BY cod_imovel, alerta')

    def test_imoveis_vigentes_e_versoes(self):
        removido = self.imoveis['removido_na_carga2']
        vigentes = {r[0] for r in self._linhas('SELECT cod_imovel FROM ref.car_imovel WHERE valido_ate IS NULL')}
        self.assertEqual(vigentes, set(self.esperado['imoveis_carga_1']) - {removido})
        self.assertEqual(len(vigentes), self.esperado['imoveis_vigentes'])
        self.assertEqual(self._linhas('SELECT count(*) FROM ref.car_imovel')[0][0], self.esperado['versoes'])

    def test_contadores_das_cargas_do_car(self):
        cargas = self._linhas("""
            SELECT data_referencia, registros, inseridos, alterados, removidos, descartados
            FROM ref.car_carga ORDER BY id""")
        esperadas = [(date.fromisoformat(c['data_referencia']), c['registros'], c['inseridos'], c['alterados'],
                      c['removidos'], c['descartados']) for c in self.esperado['cargas_car']]
        self.assertEqual(cargas, esperadas)
        self.assertEqual([c[0] for c in cargas], [self.datas['data_car_1'], self.datas['data_car_2']])

    def test_datas_das_cargas_saem_do_arquivo(self):
        # Sem --publicado-em: a data de cada carga é a atualização mais recente de um imóvel no arquivo, não o dia da carga.
        self.assertEqual(self._linhas('SELECT data_referencia, dados_ate, publicado_em FROM ref.car_carga ORDER BY id'),
                         [(self.datas['data_car_1'], self.datas['data_car_1'], None),
                          (self.datas['data_car_2'], self.datas['data_car_2'], None)])

    def test_removido_fica_so_com_a_versao_fechada(self):
        versoes = self._versoes(self.imoveis['removido_na_carga2'])
        self.assertEqual(len(versoes), 1)
        self.assertEqual(versoes[0][3:], (self.datas['data_car_1'], self.datas['data_car_2']))

    def test_alterado_ganha_versao_nova(self):
        antes, depois = self._versoes(self.imoveis['alterado_na_carga2'])
        e = self.esperado['alterado_na_carga2']
        self.assertEqual((antes[0], antes[2]), (e['antes']['status'], date.fromisoformat(e['antes']['atualizado_sicar'])))
        self.assertEqual(antes[3:], (self.datas['data_car_1'], self.datas['data_car_2']))
        self.assertEqual(depois[:3], (e['depois']['status'], e['depois']['condicao'], date.fromisoformat(e['depois']['atualizado_sicar'])))
        self.assertEqual(depois[3:], (self.datas['data_car_2'], None))

    def test_inalterados_mantem_a_versao_da_carga_1(self):
        mudaram = {self.imoveis['removido_na_carga2'], self.imoveis['alterado_na_carga2']}
        for cod in set(self.esperado['imoveis_carga_1']) - mudaram:
            with self.subTest(cod=cod):
                versoes = self._versoes(cod)
                self.assertEqual(len(versoes), 1)
                self.assertEqual(versoes[0][3:], (self.datas['data_car_1'], None))

    def test_situacoes_no_sicar(self):
        for papel, status in (('pendente', 'PE'), ('suspenso', 'SU'), ('cancelado', 'CA'), ('ativo_sem_alerta', 'AT'),
                              ('alerta_pos_corte_grande', 'AT')):
            with self.subTest(papel=papel):
                self.assertEqual(self._versoes(self.imoveis[papel])[-1][0], status)

    def test_modulos_fiscais(self):
        mf = dict(self._linhas('SELECT cod_imovel, mod_fiscal FROM ref.car_imovel WHERE valido_ate IS NULL'))
        self.assertLessEqual(mf[self.imoveis['pequena_propriedade']], 4)
        self.assertGreater(mf[self.imoveis['grande_sem_alerta']], 4)

    def test_municipios_vem_da_amostra(self):
        # A carga do CAR não foi ao IBGE: só os municípios de tests/dados/municipios.sql.
        cods = [r[0] for r in self._linhas('SELECT cod_ibge FROM ref.municipio ORDER BY cod_ibge')]
        self.assertEqual(cods, self.esperado['municipios'])

    def test_camada_do_mapbiomas(self):
        camada = self._linhas("""
            SELECT c.feicoes, c.data_referencia, c.publicado_em, c.dados_ate,
                   (SELECT count(*) FROM ref.feicao_ambiental f WHERE f.camada_id = c.id)
            FROM ref.camada c WHERE c.id = ref.camada_vigente('mapbiomas')""")
        # Com --publicado-em, a referência é a publicação; dados_ate segue sendo a detecção mais recente do arquivo.
        self.assertEqual(camada, [(self.esperado['alertas'], self.datas['data_mapbiomas'], self.datas['data_mapbiomas'],
                                   self.datas['mapbiomas_dados_ate'], self.esperado['alertas'])])
        # SOURCE com duas fontes ({SAD-MATA-ATLANTICA,SAD-PAMPA}) vira a lista `fontes`.
        fontes = self._linhas("SELECT atributos->'fontes' FROM ref.feicao_ambiental WHERE externo_id = '891194'")
        self.assertEqual(fontes, [(['SAD-MATA-ATLANTICA', 'SAD-PAMPA'],)])

    def test_pares_alerta_imovel(self):
        pares = [(cod, alerta, d, round(area, 2)) for cod, alerta, d, area in self._pares()]
        esperados = [(p['cod_imovel'], p['alerta'], date.fromisoformat(p['detectado_em']), p['area_ha'])
                     for p in self.esperado['car_alerta']]
        self.assertEqual(pares, esperados)
        com_alerta = {p[0] for p in pares}
        for papel in ('ativo_sem_alerta', 'ativo_sem_alerta_mata_atlantica', 'grande_sem_alerta'):
            self.assertNotIn(self.imoveis[papel], com_alerta, papel)

    def test_biomas_nos_tres_niveis(self):
        self.assertEqual([r[0] for r in self._linhas('SELECT nome FROM ref.bioma ORDER BY nome')], self.esperado['biomas'])
        niveis = self._linhas("""
            SELECT b.nome, array_agg(DISTINCT p.nivel ORDER BY p.nivel)
            FROM ref.bioma b JOIN ref.bioma_parte p USING (cod) GROUP BY b.nome ORDER BY b.nome""")
        self.assertEqual(niveis, [(nome, [0, 1, 2]) for nome in self.esperado['biomas']])
        self.assertEqual([r[0] for r in self._linhas('SELECT DISTINCT nivel FROM ref.bioma_limite ORDER BY 1')], [0, 1, 2])

    def test_bioma_dos_imoveis(self):
        for papel, bioma in (('pampa', 'Pampa'), ('mata_atlantica', 'Mata Atlântica')):
            with self.subTest(papel=papel):
                biomas = self._linhas("""
                    SELECT DISTINCT b.nome FROM ref.car_imovel c
                    JOIN ref.bioma_parte p ON p.nivel = 2 AND ST_Intersects(p.geom, c.geom) JOIN ref.bioma b USING (cod)
                    WHERE c.cod_imovel = %s AND c.valido_ate IS NULL""", self.imoveis[papel])
                self.assertEqual(biomas, [(bioma,)])

    def test_ficha_calculada_de_cada_imovel(self):
        # ref.car_resumo: uma linha por código, com a versão que vale; o removido fica com a última, fora do SICAR.
        fichas = {r[0]: r[1:] for r in self._linhas("""
            SELECT r.cod_imovel, r.vigente, r.situacao, r.versao_id = (
                     SELECT c.id FROM ref.car_imovel c WHERE c.cod_imovel = r.cod_imovel
                     ORDER BY c.valido_ate IS NULL DESC, c.valido_de DESC LIMIT 1)
            FROM ref.car_resumo r""")}
        self.assertEqual(set(fichas), set(self.esperado['imoveis_carga_1']))
        self.assertTrue(all(f[2] for f in fichas.values()), 'versao_id de alguma ficha não é a versão que vale')
        self.assertFalse(fichas[self.imoveis['removido_na_carga2']][0])
        self.assertEqual(fichas[self.imoveis['alterado_na_carga2']][:2], (True, self.esperado['alterado_na_carga2']['depois']['status']))
        # Refazer não muda nada: as fichas já são as das versões que valem.
        with conectar() as con:
            self.assertEqual(con.execute('SELECT ref.atualizar_car_resumo(%s)', (self.casos['uf'],)).fetchone()[0], 0)
            self.assertEqual(con.execute('SELECT ref.resumir_biomas()').fetchone()[0], 0)
            con.rollback()

    def test_biomas_e_alertas_na_ficha(self):
        fichas = {r[0]: r[1:] for r in self._linhas("""
            SELECT cod_imovel, biomas->0->>'nome', alertas, alertas_pos_corte, round(area_alertas_pos_corte_ha::numeric, 2),
                   round(maior_alerta_pos_corte_ha::numeric, 2), ultimo_alerta
            FROM ref.car_resumo""")}
        for papel, bioma in (('pampa', 'Pampa'), ('mata_atlantica', 'Mata Atlântica')):
            self.assertEqual(fichas[self.imoveis[papel]][0], bioma, papel)
        for cod in self.esperado['imoveis_carga_1']:
            with self.subTest(cod=cod):
                pares = [p for p in self.esperado['car_alerta'] if p['cod_imovel'] == cod]
                pos = [p['area_ha'] for p in pares if date.fromisoformat(p['detectado_em']) > CORTE_EUDR]
                ultimo = max((date.fromisoformat(p['detectado_em']) for p in pares), default=None)
                self.assertEqual([None if v is None else float(v) for v in fichas[cod][1:5]],
                                 [len(pares), len(pos), round(sum(pos), 2), max(pos, default=None)])
                self.assertEqual(fichas[cod][5], ultimo)

    def test_recarregar_a_carga_2_nao_cria_versoes(self):
        versoes = self._linhas('SELECT count(*) FROM ref.car_imovel')[0][0]
        pares = self._pares()
        ultima = self._linhas('SELECT max(id) FROM ref.car_carga')[0][0]
        try:
            r = subprocess.run([sys.executable, '-m', 'nt_pipeline', 'car', '--uf', self.casos['uf'], '--arquivo', CARGA_2],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertEqual(self._linhas('SELECT count(*) FROM ref.car_imovel')[0][0], versoes)
            self.assertEqual(self._linhas('SELECT registros, inseridos, alterados, removidos, descartados FROM ref.car_carga '
                                          'WHERE id > %s', ultima), [(self.esperado['imoveis_vigentes'], 0, 0, 0, 0)])
            self.assertEqual(self._pares(), pares)
        finally:
            # A carga repetida sai do banco (se não criou versão), para os testes da API verem só as duas da amostra.
            with conectar() as con:
                con.execute("""
                    DELETE FROM ref.car_carga g WHERE g.id > %s
                      AND NOT EXISTS (SELECT 1 FROM ref.car_imovel c WHERE c.carga_id = g.id)""", (ultima,))

    def test_carga_mais_antiga_que_a_ultima_e_recusada(self):
        # A carga 1 de novo: os dados vão até antes da carga 2, e o histórico das versões ficaria fora de ordem.
        cargas = self._linhas('SELECT count(*) FROM ref.car_carga')[0][0]
        r = subprocess.run([sys.executable, '-m', 'nt_pipeline', 'car', '--uf', self.casos['uf'],
                            '--arquivo', '/dados/AREA_IMOVEL/RS/AREA_IMOVEL_1.shp'], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('anterior à última carga da UF', r.stdout + r.stderr)
        self.assertEqual(self._linhas('SELECT count(*) FROM ref.car_carga')[0][0], cargas)


if __name__ == '__main__':
    unittest.main()
