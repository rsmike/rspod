import { useState, useRef, useEffect } from 'react';

function baseName(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

function ext(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot) : '';
}

export default function FileRow({ file, formatSize, formatDuration, onRename, onDelete, onTranscode }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(baseName(file.name));
  const inputRef = useRef(null);
  const isMp4 = file.name.toLowerCase().endsWith('.mp4');

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commitRename = async () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === baseName(file.name)) {
      setEditing(false);
      setEditValue(baseName(file.name));
      return;
    }
    const ok = await onRename(file.name, trimmed);
    if (!ok) setEditValue(baseName(file.name));
    setEditing(false);
  };

  return (
    <tr>
      <td>
        <span className="file-name-cell">
          {isMp4 && (
            file.transcoding
              ? <span className="badge transcoding" title="Transcoding...">...</span>
              : file.compatible
                ? <span className="badge compatible" title="Apple Podcasts compatible">&#x2713;</span>
                : <span className="badge incompatible" title="Incompatible codec">!</span>
          )}
          {editing ? (
            <>
              <input
                ref={inputRef}
                className="file-name-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') {
                    setEditValue(baseName(file.name));
                    setEditing(false);
                  }
                }}
              />
              <span className="file-ext">{ext(file.name)}</span>
            </>
          ) : (
            <span className="file-name" onClick={() => setEditing(true)}>
              {file.name}
            </span>
          )}
        </span>
      </td>
      <td className="file-meta">{formatSize(file.size)}</td>
      <td className="file-meta">{formatDuration(file.duration)}</td>
      <td className="file-actions">
        {isMp4 && !file.compatible && !file.transcoding && (
          <button className="transcode" onClick={() => onTranscode(file.name)}>transcode</button>
        )}
        <button onClick={() => setEditing(true)}>rename</button>
        <button className="danger" onClick={() => onDelete(file.name)}>delete</button>
      </td>
    </tr>
  );
}
