import { useEffect, useState } from "react";

interface Health {
  status: string;
  service: string;
  version: string;
  runtime: string;
  time: string;
  storage: { ok: boolean; migrations: number };
}

/** Phase 0: a single status page. Review queue, metrics and controls arrive in later phases. */
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setHealth(body as Health);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 720,
        margin: "2rem auto",
        padding: "0 1rem",
      }}
    >
      <h1>Agent Engine</h1>
      <p>Internal dashboard. Phase 0: system status only.</p>
      <h2>API health</h2>
      {error && <p style={{ color: "crimson" }}>Unavailable: {error}</p>}
      {!error && !health && <p>Checking…</p>}
      {health && (
        <table>
          <tbody>
            <tr>
              <th align="left">Status</th>
              <td>{health.status}</td>
            </tr>
            <tr>
              <th align="left">Runtime</th>
              <td>{health.runtime}</td>
            </tr>
            <tr>
              <th align="left">Version</th>
              <td>{health.version}</td>
            </tr>
            <tr>
              <th align="left">Database</th>
              <td>
                {health.storage.ok ? "ok" : "error"} ({health.storage.migrations} migrations)
              </td>
            </tr>
            <tr>
              <th align="left">Checked at</th>
              <td>{health.time}</td>
            </tr>
          </tbody>
        </table>
      )}
    </main>
  );
}
