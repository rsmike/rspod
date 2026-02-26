import { useState } from 'react';
import FileManager from './FileManager';
import Settings from './Settings';
import './App.css';

export default function App() {
  const [tab, setTab] = useState('files');

  return (
    <div className="app">
      <header>
        <h1>rspod</h1>
        <nav>
          <button
            className={tab === 'files' ? 'active' : ''}
            onClick={() => setTab('files')}
          >
            Files
          </button>
          <button
            className={tab === 'settings' ? 'active' : ''}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </nav>
      </header>
      <main>
        {tab === 'files' ? <FileManager /> : <Settings />}
      </main>
    </div>
  );
}
