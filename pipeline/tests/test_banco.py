"""Run with: docker compose run --rm --entrypoint python3 pipeline -m unittest discover -s tests -v"""

import os
import unittest
from unittest import mock

from nt_pipeline.banco import dsn_gdal


class ConexaoDoGdal(unittest.TestCase):
    def test_host_e_porta(self):
        with mock.patch.dict(os.environ, {'DATABASE_URL': 'postgresql://nt:segredo@db:5432/nodaltrace'}):
            self.assertEqual(dsn_gdal(), 'PG:host=db port=5432 dbname=nodaltrace user=nt password=segredo')

    def test_socket_do_cloud_sql(self):
        url = 'postgresql://nt:segredo@/nodaltrace?host=/cloudsql/projeto:regiao:instancia'
        with mock.patch.dict(os.environ, {'DATABASE_URL': url}):
            self.assertEqual(dsn_gdal(),
                             'PG:host=/cloudsql/projeto:regiao:instancia port=5432 dbname=nodaltrace user=nt password=segredo')


if __name__ == '__main__':
    unittest.main()
