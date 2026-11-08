import { useEffect, useState } from 'react';

// M0 placeholder: proves the SPA is served and can reach the API. Replaced by the real shell in M1.
export function App() {
  const [status, setStatus] = useState<string>('連線中…');
  useEffect(() => {
    fetch('/api/version').then(async response => {
      const body = await response.json() as { version?: string };
      setStatus(response.ok ? `伺服器 ${body.version ?? '?'} 已連線` : '伺服器回應錯誤');
    }).catch(() => setStatus('無法連線到伺服器'));
  }, []);
  return <main style={{ fontFamily: 'system-ui, sans-serif', padding: 32 }}>
    <h1>Notes</h1>
    <p role="status">{status}</p>
  </main>;
}
