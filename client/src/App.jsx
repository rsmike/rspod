import { useState, useEffect } from 'react';
import Login from './Login';
import FileManager from './FileManager';
import Settings from './Settings';
import UserManager from './UserManager';
import './App.css';

export default function App() {
  const [auth, setAuth] = useState(null); // null=loading, false=not authed, object=authed
  const [tab, setTab] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/auth')
      .then(r => r.json())
      .then(data => {
        if (data.authenticated) {
          setAuth(data);
          setTab(data.role === 'admin' ? 'users' : 'files');
        } else {
          setAuth(false);
        }
      })
      .catch(() => setAuth(false));
  }, []);

  const handleLogin = (session) => {
    setAuth({ authenticated: true, ...session });
    setTab(session.role === 'admin' ? 'users' : 'files');
  };

  const handleLogout = async () => {
    await fetch('/api/auth', { method: 'DELETE' });
    setAuth(false);
    setTab(null);
  };

  const copyFeedUrl = () => {
    navigator.clipboard.writeText(window.location.origin + auth.feedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (auth === null) return null;
  if (auth === false) return <Login onLogin={handleLogin} />;

  const isAdmin = auth.role === 'admin';

  return (
    <div className="app">
      <header>
        <h1>rspod</h1>
        <nav>
          {isAdmin ? (
            <>
              <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Users</button>
              <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Settings</button>
            </>
          ) : (
            <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Files</button>
          )}
          <button className="logout-btn" onClick={handleLogout}>Logout</button>
        </nav>
      </header>

      {!isAdmin && auth.feedUrl && (
        <div className="feed-url-bar">
          <code>{window.location.origin}{auth.feedUrl}</code>
          <button className="btn-copy" onClick={copyFeedUrl}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}

      <main>
        {isAdmin && tab === 'users' && <UserManager />}
        {isAdmin && tab === 'settings' && <Settings />}
        {!isAdmin && tab === 'files' && <FileManager />}
      </main>
    </div>
  );
}
