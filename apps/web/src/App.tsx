import { useEffect, useState } from 'react';
import type { Health } from '@keepsake/contracts';

// M0: the three-tab shell (spec §4) with placeholders, and the server's health. The screens arrive with M1.
const TABS = [
  { id: 'wishes', label: 'My wishes', note: 'Your wishes, for a celebration or any time, arrive with M1.' },
  { id: 'family', label: 'Family', note: 'The household and what you give them arrive with M1 and M2.' },
  { id: 'celebrations', label: 'Celebrations', note: 'Celebrations arrive with M1, their draws with M3.' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function useHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setHealth, (e: Error) => setError(e.message));
  }, []);
  return { health, error };
}

export function App() {
  const [tab, setTab] = useState<TabId>('wishes');
  const { health, error } = useHealth();
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <>
      <main className="screen" id={`panel-${current.id}`} role="tabpanel" aria-labelledby={`tab-${current.id}`}>
        <p className="eyebrow">Keepsake</p>
        <h1 className="large-title">{current.label}</h1>
        <ul className="group" aria-label={current.label}>
          <li className="row">
            <span className="row-title">Coming soon</span>
            <span className="row-sub">{current.note}</span>
          </li>
        </ul>
        <h2 className="group-header">Server</h2>
        <ul className="group">
          <li className="row row-inline">
            <span className="row-title">Status</span>
            <span className="row-value" role="status">
              {error ? `Not answering (${error})` : health ? (health.ok ? 'Running' : 'Not ready') : 'Checking…'}
            </span>
          </li>
          {health && (
            <>
              <li className="row row-inline"><span className="row-title">Version</span><span className="row-value">{health.version}</span></li>
              <li className="row row-inline"><span className="row-title">Mode</span><span className="row-value">{health.mode}</span></li>
            </>
          )}
        </ul>
      </main>
      <nav className="tab-bar" aria-label="Keepsake">
        <div role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              aria-controls={`panel-${t.id}`}
              className="tab"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
