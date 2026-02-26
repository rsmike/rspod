const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { parseFile } = require('music-metadata');

const app = express();
const PORT = process.env.PORT || 3000;
const MEDIA_DIR = fs.existsSync('/media') ? '/media' : path.join(__dirname, '..', 'media');
const SETTINGS_FILE = path.join(MEDIA_DIR, '.rspod.json');
const COVER_FILE = path.join(MEDIA_DIR, 'cover.jpg');
const ALLOWED_EXT = ['.mp3', '.mp4'];

// Ensure media directory exists
fs.mkdirSync(MEDIA_DIR, { recursive: true });

app.use(express.json());

// --- File upload config ---
const storage = multer.diskStorage({
  destination: MEDIA_DIR,
  filename: (req, file, cb) => {
    // Keep original filename, avoid overwrite by appending number
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    let name = file.originalname;
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
    const ext = path.extname(name).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) continue;
    const filePath = path.join(MEDIA_DIR, name);
    const stat = fs.statSync(filePath);
    let duration = 0;
    try {
      const metadata = await parseFile(filePath);
      duration = Math.round(metadata.format.duration || 0);
    } catch {}
    files.push({
      name,
      size: stat.size,
      duration,
      mtime: stat.mtime.toISOString(),
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
app.post('/api/files', upload.array('files'), (req, res) => {
  const uploaded = (req.files || []).map((f) => f.filename);
  res.json({ uploaded });
});

// Rename file
app.patch('/api/files/:filename', (req, res) => {
  const oldName = sanitizeFilename(req.params.filename);
  const newName = sanitizeFilename(req.body.name);

  if (!newName || newName.startsWith('.')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const ext = path.extname(newName).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    return res.status(400).json({ error: 'File must have .mp3 or .mp4 extension' });
  }

  const oldPath = path.join(MEDIA_DIR, oldName);
  const newPath = path.join(MEDIA_DIR, newName);

  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (fs.existsSync(newPath) && oldName !== newName) {
    return res.status(409).json({ error: 'A file with that name already exists' });
  }

  fs.renameSync(oldPath, newPath);
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
  res.json({ deleted: name });
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
  res.json(settings);
});

// Upload cover
app.post('/api/cover', coverUpload.single('cover'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }
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
