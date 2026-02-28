import { useState, useEffect, useRef, useCallback } from 'react';
import FileRow from './FileRow';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  if (!seconds) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export default function FileManager() {
  const [files, setFiles] = useState(null); // null = loading
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(null); // { current, total }
  const inputRef = useRef(null);
  const dragCounter = useRef(0);

  const loadFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/files');
      setFiles(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  // Poll while any file is transcoding
  useEffect(() => {
    const hasTranscoding = (files || []).some((f) => f.transcoding);
    if (!hasTranscoding) return;
    const interval = setInterval(loadFiles, 3000);
    return () => clearInterval(interval);
  }, [files, loadFiles]);

  const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB

  const uploadChunkWithRetry = async (fd, retries = 3) => {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch('/api/files/chunk', { method: 'POST', body: fd });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return;
      } catch (err) {
        if (attempt === retries - 1) throw err;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  };

  const uploadFileChunked = async (file, fileIndex, totalFiles) => {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId = `${Date.now()}-${fileIndex}`;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const chunk = file.slice(start, start + CHUNK_SIZE);
      const fd = new FormData();
      fd.append('uploadId', uploadId);
      fd.append('chunkIndex', String(i));
      fd.append('totalChunks', String(totalChunks));
      fd.append('filename', file.name);
      fd.append('chunk', chunk);

      await uploadChunkWithRetry(fd);

      setUploading({
        file: fileIndex + 1,
        totalFiles,
        chunk: i + 1,
        totalChunks,
      });
    }
  };

  const uploadFiles = async (fileList) => {
    const valid = Array.from(fileList).filter((f) => {
      const ext = f.name.split('.').pop().toLowerCase();
      return ext === 'mp3' || ext === 'mp4';
    });
    if (valid.length === 0) return;

    try {
      for (let i = 0; i < valid.length; i++) {
        setUploading({ file: i + 1, totalFiles: valid.length, chunk: 0, totalChunks: 0 });
        await uploadFileChunked(valid[i], i, valid.length);
      }
    } catch (err) {
      alert(`Upload failed: ${err.message}`);
    }

    setUploading(null);
    loadFiles();
  };

  const handleDrop = (e) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    uploadFiles(e.dataTransfer.files);
  };

  const handleDragEnter = (e) => {
    e.preventDefault();
    dragCounter.current++;
    setDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragging(false);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleRename = async (oldName, newName) => {
    const res = await fetch(`/api/files/${encodeURIComponent(oldName)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || 'Rename failed');
      return false;
    }
    loadFiles();
    return true;
  };

  const handleDelete = async (name) => {
    if (!confirm(`Delete "${name}"?`)) return;
    await fetch(`/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
    loadFiles();
  };

  const handleTranscode = async (name) => {
    await fetch(`/api/files/${encodeURIComponent(name)}/transcode`, { method: 'POST' });
    loadFiles();
  };

  return (
    <>
      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDrop={handleDrop}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
      >
        <p>{dragging ? 'Drop files here' : 'Drag mp3/mp4 files here to upload'}</p>
        <p className="hint">or click to browse</p>
        <input
          ref={inputRef}
          type="file"
          accept=".mp3,.mp4"
          multiple
          hidden
          onChange={(e) => {
            uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {uploading && (
        <div className="upload-progress">
          Uploading file {uploading.file}/{uploading.totalFiles}
          {uploading.totalChunks > 1 && ` (chunk ${uploading.chunk}/${uploading.totalChunks})`}...
        </div>
      )}

      {files === null ? (
        <p className="empty loading">Loading...</p>
      ) : files.length === 0 ? (
        <p className="empty">No files yet</p>
      ) : (
        <table className="file-list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Duration</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <FileRow
                key={file.name}
                file={file}
                formatSize={formatSize}
                formatDuration={formatDuration}
                onRename={handleRename}
                onDelete={handleDelete}
                onTranscode={handleTranscode}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
