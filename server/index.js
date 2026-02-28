const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { parseFile } = require('music-metadata');

const app = express();
const PORT = process.env.PORT || 3000;
const MEDIA_DIR = fs.existsSync('/media') ? '/media' : path.join(__dirname, '..', 'media');
const SETTINGS_FILE = path.join(MEDIA_DIR, '.rspod.json');
const COVER_FILE = path.join(MEDIA_DIR, 'cover.jpg');
const ALLOWED_EXT = ['.mp3', '.mp4'];
const MAX_TRANSCODE_SIZE = 100 * 1024 * 1024; // 100MB
const CHUNKS_DIR = path.join(MEDIA_DIR, '.chunks');
const SESSION_COOKIE = 'rspod_session';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const FEED_TOKEN_LEN = 12;

// Ensure directories exist
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(CHUNKS_DIR, { recursive: true });

// Clean up stale chunks from interrupted uploads (older than 1 hour, checked every 10 min)
const CHUNK_MAX_AGE = 60 * 60 * 1000;
function cleanStaleChunks() {
  for (const entry of fs.readdirSync(CHUNKS_DIR)) {
    const p = path.join(CHUNKS_DIR, entry);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > CHUNK_MAX_AGE) {
        fs.rmSync(p, { recursive: true, force: true });
        console.log(`Cleaned up stale chunks: ${entry}`);
      }
    } catch {}
  }
}
cleanStaleChunks();
setInterval(cleanStaleChunks, 10 * 60 * 1000);

app.use(express.json());
app.use(cookieParser());

// --- Helpers ---

function decodeFilename(name) {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return { title: 'My Podcast', author: '', description: '', language: 'en', explicit: false, masterKey: null, users: [] };
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function sanitizeFilename(name) {
  return path.basename(String(name));
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

// --- Auth ---

function generateKey() {
  return crypto.randomBytes(32).toString('base64url');
}

function isValidUserId(id) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

function getUserMediaDir(userId) {
  return path.join(MEDIA_DIR, userId);
}

function initMasterKey() {
  const settings = readSettings();
  if (settings.masterKey) return;
  const key = process.env.MASTER_KEY || generateKey();
  settings.masterKey = key;
  if (!settings.users) settings.users = [];
  writeSettings(settings);
  if (!process.env.MASTER_KEY) {
    console.log('');
    console.log(`  Master key: ${key}`);
    console.log('  Save this key — you need it to log in as admin.');
    console.log('');
  }
}

function findSession(key) {
  if (!key) return null;
  const settings = readSettings();
  if (key === settings.masterKey) return { role: 'admin' };
  const user = (settings.users || []).find(u => u.key === key);
  if (user) return { role: 'user', user };
  return null;
}

function requireAuth(req, res, next) {
  const key = req.cookies[SESSION_COOKIE];
  const session = findSession(key);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.auth = session;
  next();
}

function requireAdmin(req, res, next) {
  if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

function requireUser(req, res, next) {
  if (req.auth.role !== 'user') return res.status(403).json({ error: 'User access required' });
  next();
}

initMasterKey();

// --- File upload config ---

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = req.auth?.user ? getUserMediaDir(req.auth.user.id) : MEDIA_DIR;
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const dir = req.auth?.user ? getUserMediaDir(req.auth.user.id) : MEDIA_DIR;
    const decoded = decodeFilename(file.originalname);
    const ext = path.extname(decoded);
    const base = path.basename(decoded, ext);
    let name = `${base}${ext}`;
    let i = 1;
    while (fs.existsSync(path.join(dir, name))) {
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
const coverFilter = (req, file, cb) => cb(null, file.mimetype.startsWith('image/'));
const coverUpload = multer({ storage: coverStorage, fileFilter: coverFilter });

// --- Chunked upload config ---
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadId = sanitizeFilename(req.body.uploadId || '');
    const dir = path.join(CHUNKS_DIR, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, String(req.body.chunkIndex)),
});
const chunkUpload = multer({ storage: chunkStorage });

// --- Media helpers ---

async function getMediaFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir);
  const files = [];
  for (const name of entries) {
    if (name.startsWith('.') || name.includes('.transcoding.')) continue;
    const ext = path.extname(name).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) continue;
    const filePath = path.join(dir, name);
    const stat = fs.statSync(filePath);
    let duration = 0;
    try {
      const metadata = await parseFile(filePath);
      duration = Math.round(metadata.format.duration || 0);
    } catch {}
    let compatible = true;
    const transKey = dir + '/' + name;
    if (ext === '.mp4' && !transcoding.has(transKey)) {
      const probe = await ffprobe(filePath);
      compatible = probe.compatible;
    }
    files.push({
      name,
      size: stat.size,
      duration,
      mtime: stat.mtime.toISOString(),
      compatible: ext === '.mp3' ? true : compatible,
      transcoding: transcoding.has(transKey),
    });
  }
  files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  return files;
}

function deduplicateName(name, dir) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let result = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, result))) {
    result = `${base} (${i})${ext}`;
    i++;
  }
  return result;
}

async function assembleChunks(uploadId, originalName, totalChunks, targetDir) {
  const chunkDir = path.join(CHUNKS_DIR, uploadId);
  const finalName = deduplicateName(originalName, targetDir);
  const finalPath = path.join(targetDir, finalName);
  const writeStream = fs.createWriteStream(finalPath);

  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(chunkDir, String(i));
    const data = fs.readFileSync(chunkPath);
    writeStream.write(data);
  }
  writeStream.end();
  await new Promise((resolve) => writeStream.on('finish', resolve));

  fs.rmSync(chunkDir, { recursive: true, force: true });

  // Auto-transcode if needed
  if (path.extname(finalName).toLowerCase() === '.mp4') {
    const probe = await ffprobe(finalPath);
    if (!probe.compatible) {
      const stat = fs.statSync(finalPath);
      if (stat.size > MAX_TRANSCODE_SIZE) {
        console.log(`Incompatible codec in ${finalName} (${probe.videoCodec}/${probe.audioCodec}), too large to transcode (${(stat.size / 1048576).toFixed(0)}MB)`);
      } else {
        console.log(`Incompatible codec in ${finalName} (${probe.videoCodec}/${probe.audioCodec}), transcoding...`);
        transcodeFile(finalPath, targetDir).catch((err) => {
          console.error(`Transcode failed for ${finalName}:`, err.message);
        });
      }
    }
  }

  return finalName;
}

// --- Codec check & transcode ---
const transcoding = new Set(); // keyed by dir/filename

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

function transcodeFile(filePath, dir) {
  const name = path.basename(filePath);
  const transKey = (dir || path.dirname(filePath)) + '/' + name;
  const tmpPath = filePath + '.transcoding.mp4';
  transcoding.add(transKey);
  console.log(`Transcode started: ${name}`);

  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-i', filePath, '-c:v', 'libx264', '-c:a', 'aac',
      '-movflags', '+faststart', '-y', tmpPath,
    ], (err) => {
      transcoding.delete(transKey);
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

// ===== ROUTES =====

// --- Auth routes (public) ---

app.post('/api/auth', (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });
  const session = findSession(key);
  if (!session) return res.status(401).json({ error: 'Invalid key' });

  res.cookie(SESSION_COOKIE, key, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });

  if (session.role === 'admin') {
    return res.json({ role: 'admin' });
  }
  const { user } = session;
  res.json({
    role: 'user',
    user: { id: user.id, name: user.name },
    feedUrl: `/${user.id}/${user.key.slice(0, FEED_TOKEN_LEN)}`,
  });
});

app.get('/api/auth', (req, res) => {
  const key = req.cookies[SESSION_COOKIE];
  const session = findSession(key);
  if (!session) return res.json({ authenticated: false });

  if (session.role === 'admin') {
    return res.json({ authenticated: true, role: 'admin' });
  }
  const { user } = session;
  res.json({
    authenticated: true,
    role: 'user',
    user: { id: user.id, name: user.name },
    feedUrl: `/${user.id}/${user.key.slice(0, FEED_TOKEN_LEN)}`,
  });
});

app.delete('/api/auth', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// Direct login via URL (bookmarkable: {root}/{key})
app.get('/:key', (req, res, next) => {
  const session = findSession(req.params.key);
  if (!session) return next();
  res.cookie(SESSION_COOKIE, req.params.key, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });
  res.redirect('/');
});

// Cover image — public (RSS feeds reference it)
app.get('/api/cover', (req, res) => {
  if (fs.existsSync(COVER_FILE)) return res.sendFile(COVER_FILE);
  res.status(404).json({ error: 'No cover image' });
});

// --- Auth wall for all other /api routes ---
app.use('/api', requireAuth);

// --- User management (admin only) ---

app.get('/api/users', requireAdmin, (req, res) => {
  const settings = readSettings();
  const users = (settings.users || []).map(u => ({
    id: u.id,
    name: u.name,
    key: u.key,
    feedUrl: `/${u.id}/${u.key.slice(0, FEED_TOKEN_LEN)}`,
  }));
  res.json(users);
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { name, id } = req.body;
  if (!name || !id) return res.status(400).json({ error: 'Name and ID required' });
  if (!isValidUserId(id)) return res.status(400).json({ error: 'ID must be alphanumeric, hyphens, or underscores (1-64 chars)' });

  const settings = readSettings();
  if (!settings.users) settings.users = [];
  if (settings.users.find(u => u.id === id)) return res.status(409).json({ error: 'User ID already exists' });

  const key = generateKey();
  const user = { id, name, key };
  settings.users.push(user);
  writeSettings(settings);

  fs.mkdirSync(getUserMediaDir(id), { recursive: true });
  console.log(`User created: ${name} (${id})`);
  res.json({ id, name, key, feedUrl: `/${id}/${key.slice(0, FEED_TOKEN_LEN)}` });
});

app.patch('/api/users/:id', requireAdmin, (req, res) => {
  const { name } = req.body;
  const settings = readSettings();
  const user = (settings.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (name) user.name = name;
  writeSettings(settings);
  res.json({ id: user.id, name: user.name, key: user.key, feedUrl: `/${user.id}/${user.key.slice(0, FEED_TOKEN_LEN)}` });
});

app.post('/api/users/:id/regenerate-key', requireAdmin, (req, res) => {
  const settings = readSettings();
  const user = (settings.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.key = generateKey();
  writeSettings(settings);
  console.log(`Regenerated key for user: ${user.name} (${user.id})`);
  res.json({ id: user.id, name: user.name, key: user.key, feedUrl: `/${user.id}/${user.key.slice(0, FEED_TOKEN_LEN)}` });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const settings = readSettings();
  const idx = (settings.users || []).findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const [removed] = settings.users.splice(idx, 1);
  writeSettings(settings);
  console.log(`User deleted: ${removed.name} (${removed.id})`);
  res.json({ deleted: removed.id });
});

// --- File management (user only) ---

app.get('/api/files', requireUser, async (req, res) => {
  try {
    const dir = getUserMediaDir(req.auth.user.id);
    fs.mkdirSync(dir, { recursive: true });
    const files = await getMediaFiles(dir);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files', requireUser, upload.array('files'), async (req, res) => {
  const dir = getUserMediaDir(req.auth.user.id);
  const uploaded = (req.files || []).map((f) => f.filename);
  for (const name of uploaded) console.log(`Uploaded: ${name}`);
  for (const f of req.files || []) {
    if (path.extname(f.filename).toLowerCase() === '.mp4') {
      const probe = await ffprobe(f.path);
      if (!probe.compatible) {
        const stat = fs.statSync(f.path);
        if (stat.size > MAX_TRANSCODE_SIZE) {
          console.log(`Incompatible codec in ${f.filename} (${probe.videoCodec}/${probe.audioCodec}), too large to transcode (${(stat.size / 1048576).toFixed(0)}MB)`);
        } else {
          console.log(`Incompatible codec in ${f.filename} (${probe.videoCodec}/${probe.audioCodec}), transcoding...`);
          transcodeFile(f.path, dir).catch((err) => {
            console.error(`Transcode failed for ${f.filename}:`, err.message);
          });
        }
      }
    }
  }
  res.json({ uploaded });
});

app.post('/api/files/chunk', requireUser, chunkUpload.single('chunk'), async (req, res) => {
  const { uploadId, chunkIndex, totalChunks, filename } = req.body;
  if (!uploadId || chunkIndex == null || !totalChunks || !filename) {
    return res.status(400).json({ error: 'Missing chunk metadata' });
  }

  const idx = parseInt(chunkIndex, 10);
  const total = parseInt(totalChunks, 10);
  console.log(`Chunk ${idx + 1}/${total} for ${filename}`);

  if (idx === total - 1) {
    const targetDir = getUserMediaDir(req.auth.user.id);
    fs.mkdirSync(targetDir, { recursive: true });
    console.log(`Assembling ${total} chunks for ${filename}...`);
    const name = await assembleChunks(uploadId, filename, total, targetDir);
    console.log(`Assembled: ${name}`);
    return res.json({ done: true, name });
  }
  res.json({ done: false, chunkIndex: idx });
});

app.patch('/api/files/:filename', requireUser, (req, res) => {
  const dir = getUserMediaDir(req.auth.user.id);
  const oldName = sanitizeFilename(req.params.filename);
  const baseName = String(req.body.name || '').trim();
  if (!baseName || baseName.startsWith('.')) return res.status(400).json({ error: 'Invalid filename' });

  const transKey = dir + '/' + oldName;
  if (transcoding.has(transKey)) return res.status(409).json({ error: 'File is currently being transcoded' });

  const ext = path.extname(oldName);
  const newName = baseName + ext;
  const oldPath = path.join(dir, oldName);
  const newPath = path.join(dir, newName);
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'File not found' });
  if (fs.existsSync(newPath) && oldName !== newName) return res.status(409).json({ error: 'A file with that name already exists' });

  fs.renameSync(oldPath, newPath);
  console.log(`Renamed: ${oldName} -> ${newName}`);
  res.json({ name: newName });
});

app.delete('/api/files/:filename', requireUser, (req, res) => {
  const dir = getUserMediaDir(req.auth.user.id);
  const name = sanitizeFilename(req.params.filename);
  const filePath = path.join(dir, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  fs.unlinkSync(filePath);
  try { fs.unlinkSync(filePath + '.transcoding.mp4'); } catch {}
  console.log(`Deleted: ${name}`);
  res.json({ deleted: name });
});

app.post('/api/files/:filename/transcode', requireUser, async (req, res) => {
  const dir = getUserMediaDir(req.auth.user.id);
  const name = sanitizeFilename(req.params.filename);
  const filePath = path.join(dir, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const transKey = dir + '/' + name;
  if (transcoding.has(transKey)) return res.status(409).json({ error: 'Already transcoding' });

  transcodeFile(filePath, dir).catch((err) => {
    console.error(`Transcode failed for ${name}:`, err.message);
  });
  res.json({ transcoding: true });
});

// --- Settings (admin only) ---

app.get('/api/settings', requireAdmin, (req, res) => {
  const { masterKey, users, ...publicSettings } = readSettings();
  res.json(publicSettings);
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const { title, author, description, language, explicit } = req.body;
  const settings = readSettings();
  settings.title = title;
  settings.author = author;
  settings.description = description;
  settings.language = language;
  settings.explicit = !!explicit;
  writeSettings(settings);
  console.log(`Settings saved: ${settings.title}`);
  const { masterKey, users, ...publicSettings } = settings;
  res.json(publicSettings);
});

app.post('/api/cover', requireAdmin, coverUpload.single('cover'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  console.log('Cover image uploaded');
  res.json({ ok: true });
});

// --- Public: per-user podcast feed & media ---

app.get('/:userId/:token', async (req, res, next) => {
  const { userId, token } = req.params;
  if (!isValidUserId(userId)) return next();

  const settings = readSettings();
  const user = (settings.users || []).find(u => u.id === userId);
  if (!user) return next();

  const feedToken = user.key.slice(0, FEED_TOKEN_LEN);

  // Feed URL
  if (token === feedToken) {
    const userDir = getUserMediaDir(userId);
    const files = await getMediaFiles(userDir);
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const baseUrl = `${proto}://${req.get('host')}`;
    const hasCover = fs.existsSync(COVER_FILE);
    const coverUrl = `${baseUrl}/api/cover`;

    let items = '';
    for (const file of files) {
      if (!file.compatible || file.transcoding) continue;
      const enclosureUrl = `${baseUrl}/${userId}/${encodeURIComponent(file.name)}`;
      items += `
    <item>
      <title>${escapeXml(path.basename(file.name, path.extname(file.name)))}</title>
      <enclosure url="${escapeXml(enclosureUrl)}" length="${file.size}" type="${getMimeType(file.name)}" />
      <guid isPermaLink="false">${escapeXml(userId + '/' + file.name)}</guid>
      <pubDate>${new Date(file.mtime).toUTCString()}</pubDate>
      <itunes:duration>${formatDuration(file.duration)}</itunes:duration>
      <itunes:explicit>${settings.explicit ? 'true' : 'false'}</itunes:explicit>
    </item>`;
    }

    const podTitle = user.name
      ? `${settings.title || 'My Podcast'} — ${user.name}`
      : settings.title || 'My Podcast';

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(podTitle)}</title>
    <description>${escapeXml(settings.description || '')}</description>
    <language>${escapeXml(settings.language || 'en')}</language>
    <itunes:author>${escapeXml(settings.author || '')}</itunes:author>
    <itunes:explicit>${settings.explicit ? 'true' : 'false'}</itunes:explicit>
    ${hasCover ? `<itunes:image href="${escapeXml(coverUrl)}" />` : ''}
    ${hasCover ? `<image><url>${escapeXml(coverUrl)}</url><title>${escapeXml(podTitle)}</title></image>` : ''}
    <link>${escapeXml(baseUrl)}</link>
    ${items}
  </channel>
</rss>`;

    return res.type('application/rss+xml').send(xml);
  }

  // Media file
  const sanitized = sanitizeFilename(token);
  const filePath = path.join(getUserMediaDir(userId), sanitized);
  if (fs.existsSync(filePath)) return res.sendFile(filePath);

  next();
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
