# Banco da demo no Railway: o mesmo PostGIS do docker-compose.yml (PostgreSQL 17.5, PostGIS 3.5.2), para o dump do banco
# reduzido (deploy/demo/reduzir.sh) restaurar sem conversão. Contexto: a raiz do repositório.
FROM imresamu/postgis:17-3.5.2-bullseye@sha256:a3d4005d657e4c226e2614325f3ea2b232739125df4ebab159d77a9ed90d98ca
# O volume do Railway fica em /var/lib/postgresql/data e tem lost+found na raiz: os dados vão numa subpasta.
ENV PGDATA=/var/lib/postgresql/data/pgdata
# Banco de ~0,5 GB com poucos acessos: memória de serviço pequeno. Sem consultas paralelas, que usam o /dev/shm, pequeno
# no contêiner.
CMD ["postgres", "-c", "shared_buffers=128MB", "-c", "effective_cache_size=512MB", "-c", "work_mem=16MB", \
     "-c", "maintenance_work_mem=128MB", "-c", "max_parallel_workers_per_gather=0", "-c", "max_connections=40", \
     "-c", "random_page_cost=1.1", "-c", "jit=off"]
