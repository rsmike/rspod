import { useState, useEffect, useCallback } from 'react';

export default function UserManager() {
  const [users, setUsers] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newId, setNewId] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);

  const loadUsers = useCallback(async () => {
    const res = await fetch('/api/users');
    if (res.ok) setUsers(await res.json());
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const handleAdd = async () => {
    setError('');
    if (!newName.trim() || !newId.trim()) {
      setError('Name and ID are required');
      return;
    }
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), id: newId.trim() }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error || 'Failed to create user');
      return;
    }
    setNewName('');
    setNewId('');
    setShowAdd(false);
    loadUsers();
  };

  const handleDelete = async (userId) => {
    if (!confirm(`Delete user "${userId}"?`)) return;
    await fetch(`/api/users/${userId}`, { method: 'DELETE' });
    loadUsers();
  };

  const handleRegenerateKey = async (userId) => {
    if (!confirm('Regenerate key? The current feed URL will stop working.')) return;
    await fetch(`/api/users/${userId}/regenerate-key`, { method: 'POST' });
    loadUsers();
  };

  const copyToClipboard = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

  return (
    <div className="user-manager">
      {!showAdd ? (
        <button className="btn" onClick={() => setShowAdd(true)}>Add user</button>
      ) : (
        <div className="add-user-form">
          <input
            placeholder="Name"
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              if (!newId || newId === slugify(newName)) setNewId(slugify(e.target.value));
            }}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          <input
            placeholder="ID (url-safe)"
            value={newId}
            onChange={(e) => setNewId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          <button className="btn" onClick={handleAdd}>Create</button>
          <button className="btn-secondary" onClick={() => { setShowAdd(false); setError(''); }}>Cancel</button>
          {error && <p className="message error">{error}</p>}
        </div>
      )}

      {users.length === 0 ? (
        <p className="empty">No users yet. Add one to get started.</p>
      ) : (
        <table className="user-list">
          <thead>
            <tr>
              <th>User</th>
              <th>Feed URL</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <div className="user-name">{user.name}</div>
                  <div className="user-id">{user.id}</div>
                </td>
                <td>
                  <div className="user-feed-url">
                    <code>{window.location.origin}{user.feedUrl}</code>
                    <button
                      className="btn-copy"
                      onClick={() => copyToClipboard(window.location.origin + user.feedUrl, 'feed-' + user.id)}
                    >
                      {copied === 'feed-' + user.id ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div className="user-key">
                    <span
                      title="Click to copy full key"
                      onClick={() => copyToClipboard(user.key, 'key-' + user.id)}
                    >
                      key: {copied === 'key-' + user.id ? 'Copied!' : user.key.slice(0, 8) + '...'}
                    </span>
                  </div>
                </td>
                <td className="user-actions">
                  <button onClick={() => handleRegenerateKey(user.id)}>regenerate</button>
                  <button className="danger" onClick={() => handleDelete(user.id)}>delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
