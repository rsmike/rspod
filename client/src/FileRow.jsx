import { useState, useRef, useEffect } from 'react';

export default function FileRow({ file, formatSize, formatDuration, onRename, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(file.name);
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      // Select name without extension
      const dotIndex = file.name.lastIndexOf('.');
      inputRef.current.setSelectionRange(0, dotIndex > 0 ? dotIndex : file.name.length);
    }
  }, [editing, file.name]);

  const commitRename = async () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === file.name) {
      setEditing(false);
      setEditValue(file.name);
      return;
    }
    const ok = await onRename(file.name, trimmed);
    if (!ok) setEditValue(file.name);
    setEditing(false);
  };

  return (
    <tr>
      <td>
        {editing ? (
          <input
            ref={inputRef}
            className="file-name-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setEditValue(file.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="file-name" onClick={() => setEditing(true)}>
            {file.name}
          </span>
        )}
      </td>
      <td className="file-meta">{formatSize(file.size)}</td>
      <td className="file-meta">{formatDuration(file.duration)}</td>
      <td className="file-actions">
        <button onClick={() => setEditing(true)}>rename</button>
        <button className="danger" onClick={() => onDelete(file.name)}>delete</button>
      </td>
    </tr>
  );
}
