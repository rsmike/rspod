import { useState, useEffect } from 'react';
import './App.css';

export default function App() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => setStatus(data.status))
      .catch(() => setStatus('error'));
  }, []);

  return (
    <div className="app">
      <h1>rspod</h1>
      <p>API status: {status ?? 'loading...'}</p>
    </div>
  );
}
