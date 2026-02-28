import { useState, useEffect, useRef } from 'react';

export default function Settings() {
  const [settings, setSettings] = useState({
    title: '',
    author: '',
    description: '',
    language: 'en',
    explicit: false,
  });
  const [saved, setSaved] = useState(false);
  const [coverUrl, setCoverUrl] = useState(null);
  const coverInputRef = useRef(null);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then(setSettings)
      .catch(() => {});
    checkCover();
  }, []);

  const checkCover = () => {
    fetch('/api/cover', { method: 'HEAD' })
      .then((r) => {
        if (r.ok) setCoverUrl(`/api/cover?t=${Date.now()}`);
      })
      .catch(() => {});
  };

  const handleSave = async () => {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleCoverUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('cover', file);
    await fetch('/api/cover', { method: 'POST', body: fd });
    setCoverUrl(`/api/cover?t=${Date.now()}`);
    e.target.value = '';
  };

  const update = (key, value) => setSettings((s) => ({ ...s, [key]: value }));

  return (
    <div className="settings">
      <div className="field">
        <label>Cover Image</label>
        <div className="cover-section">
          {coverUrl ? (
            <img className="cover-preview" src={coverUrl} alt="Cover" />
          ) : (
            <div className="cover-placeholder">No cover</div>
          )}
          <div>
            <button className="btn btn-secondary" onClick={() => coverInputRef.current?.click()}>
              Upload cover
            </button>
            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={handleCoverUpload}
            />
          </div>
        </div>
      </div>

      <div className="field">
        <label>Podcast Title</label>
        <input value={settings.title} onChange={(e) => update('title', e.target.value)} />
      </div>

      <div className="field">
        <label>Author</label>
        <input value={settings.author} onChange={(e) => update('author', e.target.value)} />
      </div>

      <div className="field">
        <label>Description</label>
        <textarea
          value={settings.description}
          onChange={(e) => update('description', e.target.value)}
        />
      </div>

      <div className="field">
        <label>Language</label>
        <input value={settings.language} onChange={(e) => update('language', e.target.value)} />
      </div>

      <div className="field checkbox-field">
        <input
          type="checkbox"
          id="explicit"
          checked={settings.explicit}
          onChange={(e) => update('explicit', e.target.checked)}
        />
        <label htmlFor="explicit">Explicit content</label>
      </div>

      <button className="btn" onClick={handleSave}>
        Save Settings
      </button>
      {saved && <span className="message">Settings saved</span>}
    </div>
  );
}
