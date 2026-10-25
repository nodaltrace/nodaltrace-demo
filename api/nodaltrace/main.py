"""A API: rotas/ (HTTP) → servicos/ (orquestração e fontes externas) → consultas/ (SQL) e dominio/ (regras puras), com
as respostas tipadas em modelos/. Os erros das camadas (erros.py) e do banco viram respostas aqui."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from psycopg.errors import QueryCanceled
from psycopg_pool import PoolTimeout

from .banco import pool
from .erros import ErroApi
from .rotas import analises, car, imagens, relatorios, renovabio, saude, verificacao
from .servicos import ancoragem
from .servicos.imagens import formato


@asynccontextmanager
async def ciclo(_: FastAPI):
    pool.open()
    # Confere o driver WebP do GDAL na subida (sem ele, as imagens históricas saem em JPEG).
    formato()
    # O registro dos relatórios na Solana, em segundo plano (só com o attestor configurado e fora do banco de testes).
    ancoragem.iniciar()
    yield
    ancoragem.parar()
    pool.close()


app = FastAPI(title='NodalTrace API', version='0.1.0', lifespan=ciclo)
for _rotas in (saude, car, imagens, analises, relatorios, renovabio, verificacao):
    app.include_router(_rotas.router)


@app.exception_handler(ErroApi)
def _erro_api(_: Request, e: ErroApi) -> JSONResponse:
    return JSONResponse({'detail': e.detalhe}, status_code=e.status)


@app.exception_handler(QueryCanceled)
def _consulta_demorada(_: Request, e: QueryCanceled) -> JSONResponse:
    return JSONResponse({'detail': 'The query exceeded the time limit. Try again, or with fewer properties.'}, status_code=503)


@app.exception_handler(PoolTimeout)
def _sem_conexao(_: Request, e: PoolTimeout) -> JSONResponse:
    return JSONResponse({'detail': 'The API is busy. Try again in a moment.'}, status_code=503)
