/** Orientação para quando a API não responde: a mesma no login e dentro do app. */
export function ComoSubirApi() {
  return (
    <>
      <p>NodalTrace needs the database, the tile server and the API running. From the repository root:</p>
      <pre className="nt-hash">docker compose up -d</pre>
    </>
  )
}
