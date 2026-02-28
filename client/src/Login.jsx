import { useState, useRef, useEffect } from 'react';

export default function Login({ onLogin }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!key.trim() || loading) return;

    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim() }),
      });
      if (!res.ok) {
        setError(true);
        setLoading(false);
        return;
      }
      const data = await res.json();
      onLogin(data);
    } catch {
      setError(true);
      setLoading(false);
    }
  };

  return (
    <div className="login">
      <h1>rspod</h1>
      <form onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          type="password"
          placeholder="Enter key"
          value={key}
          onChange={(e) => { setKey(e.target.value); setError(false); }}
          className={error ? 'shake' : ''}
          onAnimationEnd={() => setError(false)}
        />
      </form>
    </div>
  );
}
