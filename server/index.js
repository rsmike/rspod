const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const multer = require('multer');
const { parseFile } = require('music-metadata');

const app = express();
const PORT = process.env.PORT || 3000;
const MEDIA_DIR = fs.existsSync('/media') ? '/media' : path.join(__dirname, '..', 'media');
const SETTINGS_FILE = path.join(MEDIA_DIR, '.rspod.json');
const COVER_FILE = path.join(MEDIA_DIR, 'cover.jpg');
const ALLOWED_EXT = ['.mp3', '.mp4'];
const MAX_TRANSCODE_SIZE = 100 * 1024 * 1024; // 100MB
const CHUNKS_DIR = path.join(MEDIA_DIR, '.chunks');

// Ensure directories exist
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(CHUNKS_DIR, { recursive: true });

app.use(express.json());

// --- File upload config ---
// Decode non-latin filenames (multer gives Latin-1 encoded originalname)
function decodeFilename(name) {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

const storage = multer.diskStorage({
  destination: MEDIA_DIR,
  filename: (req, file, cb) => {
    // Keep original filename, avoid overwrite by appending number
    const decoded = decodeFilename(file.originalname);
    const ext = path.extname(decoded);
    const base = path.basename(decoded, ext);
    let name = `${base}${ext}`;
    let i = 1;
    while (fs.existsSync(path.join(MEDIA_DIR, name))) {
      name = `${base} (${i})${ext}`;
      i++;
    }
    cb(null, name);
  },
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  cb(null, ALLOWED_EXT.includes(ext));
};

const upload = multer({ storage, fileFilter });

// --- Cover upload config ---
const coverStorage = multer.diskStorage({
  destination: MEDIA_DIR,
  filename: (req, file, cb) => cb(null, 'cover.jpg'),
});

const coverFilter = (req, file, cb) => {
  cb(null, file.mimetype.startsWith('image/'));
};

const coverUpload = multer({ storage: coverStorage, fileFilter: coverFilter });

// --- Helpers ---
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return { title: 'My Podcast', author: '', description: '', language: 'en', explicit: false };
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

async function getMediaFiles() {
  const entries = fs.readdirSync(MEDIA_DIR);
  const files = [];
  for (const name of entries) {
    if (name.startsWith('.') || name.includes('.transcoding.')) continue;
    const ext = path.extname(name).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) continue;
    const filePath = path.join(MEDIA_DIR, name);
    const stat = fs.statSync(filePath);
    let duration = 0;
    try {
      const metadata = await parseFile(filePath);
      duration = Math.round(metadata.format.duration || 0);
    } catch {}
    let compatible = true;
    if (ext === '.mp4' && !transcoding.has(name)) {
      const probe = await ffprobe(filePath);
      compatible = probe.compatible;
    }
    files.push({
      name,
      size: stat.size,
      duration,
      mtime: stat.mtime.toISOString(),
      compatible: ext === '.mp3' ? true : compatible,
      transcoding: transcoding.has(name),
    });
  }
  files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  return files;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.mp4' ? 'video/mp4' : 'audio/mpeg';
}

// --- Chunked upload helpers ---
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadId = sanitizeFilename(req.body.uploadId || '');
    const dir = path.join(CHUNKS_DIR, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, String(req.body.chunkIndex));
  },
});
const chunkUpload = multer({ storage: chunkStorage });

function deduplicateName(name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let result = name;
  let i = 1;
  while (fs.existsSync(path.join(MEDIA_DIR, result))) {
    result = `${base} (${i})${ext}`;
    i++;
  }
  return result;
}

async function assembleChunks(uploadId, originalName, totalChunks) {
  const chunkDir = path.join(CHUNKS_DIR, uploadId);
  const finalName = deduplicateName(originalName);
  const finalPath = path.join(MEDIA_DIR, finalName);
  const writeStream = fs.createWriteStream(finalPath);

  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(chunkDir, String(i));
    const data = fs.readFileSync(chunkPath);
    writeStream.write(data);
  }
  writeStream.end();
  await new Promise((resolve) => writeStream.on('finish', resolve));

  // Clean up chunks
  fs.rmSync(chunkDir, { recursive: true, force: true });

  // Auto-transcode if needed (skip large files)
  if (path.extname(finalName).toLowerCase() === '.mp4') {
    const probe = await ffprobe(finalPath);
    if (!probe.compatible) {
      const stat = fs.statSync(finalPath);
      if (stat.size > MAX_TRANSCODE_SIZE) {
        console.log(`Incompatible codec in ${finalName} (${probe.videoCodec}/${probe.audioCodec}), too large to transcode (${(stat.size / 1048576).toFixed(0)}MB)`);
      } else {
        console.log(`Incompatible codec in ${finalName} (${probe.videoCodec}/${probe.audioCodec}), transcoding...`);
        transcodeFile(finalPath).catch((err) => {
          console.error(`Transcode failed for ${finalName}:`, err.message);
        });
      }
    }
  }

  return finalName;
}

// --- Codec check & transcode ---
const transcoding = new Set();

function ffprobe(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', filePath,
    ], (err, stdout) => {
      if (err) return resolve({ videoCodec: null, audioCodec: null, compatible: false });
      try {
        const { streams } = JSON.parse(stdout);
        const video = streams.find((s) => s.codec_type === 'video');
        const audio = streams.find((s) => s.codec_type === 'audio');
        const videoCodec = video?.codec_name || null;
        const audioCodec = audio?.codec_name || null;
        const compatible = videoCodec === 'h264' && (audioCodec === 'aac' || !audio);
        resolve({ videoCodec, audioCodec, compatible });
      } catch {
        resolve({ videoCodec: null, audioCodec: null, compatible: false });
      }
    });
  });
}

function transcodeFile(filePath) {
  const name = path.basename(filePath);
  const tmpPath = filePath + '.transcoding.mp4';
  transcoding.add(name);
  console.log(`Transcode started: ${name}`);

  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-i', filePath, '-c:v', 'libx264', '-c:a', 'aac',
      '-movflags', '+faststart', '-y', tmpPath,
    ], (err) => {
      transcoding.delete(name);
      if (err) {
        console.error(`Transcode failed: ${name} — ${err.message}`);
        try { fs.unlinkSync(tmpPath); } catch {}
        return reject(err);
      }
      fs.renameSync(tmpPath, filePath);
      console.log(`Transcode done: ${name}`);
      resolve();
    });
  });
}

// Sanitize filename to prevent path traversal
function sanitizeFilename(name) {
  return path.basename(String(name));
}

// --- API Routes ---

// List files
app.get('/api/files', async (req, res) => {
  try {
    const files = await getMediaFiles();
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload files
app.post('/api/files', upload.array('files'), async (req, res) => {
  const uploaded = (req.files || []).map((f) => f.filename);
  for (const name of uploaded) console.log(`Uploaded: ${name}`);
  // Auto-transcode incompatible MP4s in background (skip large files)
  for (const f of req.files || []) {
    if (path.extname(f.filename).toLowerCase() === '.mp4') {
      const probe = await ffprobe(f.path);
      if (!probe.compatible) {
        const stat = fs.statSync(f.path);
        if (stat.size > MAX_TRANSCODE_SIZE) {
          console.log(`Incompatible codec in ${f.filename} (${probe.videoCodec}/${probe.audioCodec}), too large to transcode (${(stat.size / 1048576).toFixed(0)}MB)`);
        } else {
          console.log(`Incompatible codec in ${f.filename} (${probe.videoCodec}/${probe.audioCodec}), transcoding...`);
          transcodeFile(f.path).catch((err) => {
            console.error(`Transcode failed for ${f.filename}:`, err.message);
          });
        }
      }
    }
  }
  res.json({ uploaded });
});

// Chunked upload
app.post('/api/files/chunk', chunkUpload.single('chunk'), async (req, res) => {
  const { uploadId, chunkIndex, totalChunks, filename } = req.body;

  if (!uploadId || chunkIndex == null || !totalChunks || !filename) {
    return res.status(400).json({ error: 'Missing chunk metadata' });
  }

  const idx = parseInt(chunkIndex, 10);
  const total = parseInt(totalChunks, 10);

  console.log(`Chunk ${idx + 1}/${total} for ${filename}`);

  // Check if all chunks are uploaded
  if (idx === total - 1) {
    console.log(`Assembling ${total} chunks for ${filename}...`);
    const name = await assembleChunks(uploadId, filename, total);
    console.log(`Assembled: ${name}`);
    return res.json({ done: true, name });
  }

  res.json({ done: false, chunkIndex: idx });
});

// Rename file (receives base name without extension)
app.patch('/api/files/:filename', (req, res) => {
  const oldName = sanitizeFilename(req.params.filename);
  const baseName = String(req.body.name || '').trim();

  if (!baseName || baseName.startsWith('.')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  if (transcoding.has(oldName)) {
    return res.status(409).json({ error: 'File is currently being transcoded' });
  }

  const ext = path.extname(oldName);
  const newName = baseName + ext;
  const oldPath = path.join(MEDIA_DIR, oldName);
  const newPath = path.join(MEDIA_DIR, newName);

  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (fs.existsSync(newPath) && oldName !== newName) {
    return res.status(409).json({ error: 'A file with that name already exists' });
  }

  fs.renameSync(oldPath, newPath);
  console.log(`Renamed: ${oldName} -> ${newName}`);
  res.json({ name: newName });
});

// Delete file
app.delete('/api/files/:filename', (req, res) => {
  const name = sanitizeFilename(req.params.filename);
  const filePath = path.join(MEDIA_DIR, name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.unlinkSync(filePath);
  console.log(`Deleted: ${name}`);
  res.json({ deleted: name });
});

// Transcode file
app.post('/api/files/:filename/transcode', async (req, res) => {
  const name = sanitizeFilename(req.params.filename);
  const filePath = path.join(MEDIA_DIR, name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (transcoding.has(name)) {
    return res.status(409).json({ error: 'Already transcoding' });
  }

  transcodeFile(filePath).catch((err) => {
    console.error(`Transcode failed for ${name}:`, err.message);
  });
  res.json({ transcoding: true });
});

// Get settings
app.get('/api/settings', (req, res) => {
  res.json(readSettings());
});

// Save settings
app.put('/api/settings', (req, res) => {
  const { title, author, description, language, explicit } = req.body;
  const settings = { title, author, description, language, explicit: !!explicit };
  writeSettings(settings);
  console.log(`Settings saved: ${settings.title}`);
  res.json(settings);
});

// Upload cover
app.post('/api/cover', coverUpload.single('cover'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }
  console.log('Cover image uploaded');
  res.json({ ok: true });
});

// Serve cover
app.get('/api/cover', (req, res) => {
  if (fs.existsSync(COVER_FILE)) {
    return res.sendFile(COVER_FILE);
  }
  res.status(404).json({ error: 'No cover image' });
});

// Serve media files
app.use('/media', express.static(MEDIA_DIR));

// --- Podcast RSS Feed ---
app.get('/podcast', async (req, res) => {
  const settings = readSettings();
  const files = await getMediaFiles();
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const baseUrl = `${proto}://${req.get('host')}`;

  const hasCover = fs.existsSync(COVER_FILE);
  const coverUrl = `${baseUrl}/api/cover`;

  let items = '';
  for (const file of files) {
    if (!file.compatible || file.transcoding) continue;
    const enclosureUrl = `${baseUrl}/media/${encodeURIComponent(file.name)}`;
    items += `
    <item>
      <title>${escapeXml(path.basename(file.name, path.extname(file.name)))}</title>
      <enclosure url="${escapeXml(enclosureUrl)}" length="${file.size}" type="${getMimeType(file.name)}" />
      <guid isPermaLink="false">${escapeXml(file.name)}</guid>
      <pubDate>${new Date(file.mtime).toUTCString()}</pubDate>
      <itunes:duration>${formatDuration(file.duration)}</itunes:duration>
      <itunes:explicit>${settings.explicit ? 'true' : 'false'}</itunes:explicit>
    </item>`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(settings.title || 'My Podcast')}</title>
    <description>${escapeXml(settings.description || '')}</description>
    <language>${escapeXml(settings.language || 'en')}</language>
    <itunes:author>${escapeXml(settings.author || '')}</itunes:author>
    <itunes:explicit>${settings.explicit ? 'true' : 'false'}</itunes:explicit>
    ${hasCover ? `<itunes:image href="${escapeXml(coverUrl)}" />` : ''}
    ${hasCover ? `<image><url>${escapeXml(coverUrl)}</url><title>${escapeXml(settings.title || 'My Podcast')}</title></image>` : ''}
    <link>${escapeXml(baseUrl)}</link>
    ${items}
  </channel>
</rss>`;

  res.type('application/rss+xml').send(xml);
});

// --- Serve frontend (production) ---
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`rspod listening on port ${PORT}`);
  console.log(`Media directory: ${MEDIA_DIR}`);
});
