// api/index.js — Independence project server-side video generator (Serverless-friendly)

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { execFile } = require('child_process');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();

// === Allowed origins - exact values ===
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://vercel-frontend-sigma-nine.vercel.app'
  // If your frontend origin is different, add it here (exact match).
];

// === CORS options for cors() middleware ===
const corsOptions = {
  origin: function (origin, callback) {
    // allow non-browser tools (no origin) — e.g., curl, Postman
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Origin', 'Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  preflightContinue: false,
  optionsSuccessStatus: 204,
  credentials: false
};

// ---------------------------
// 0) Utility: middleware to ALWAYS set CORS headers (fallback + explicit)
//    Put this very early so OPTIONS and errors get headers.
// ---------------------------
function setCorsHeaders(req, res, next) {
  try {
    const origin = req.headers.origin;
    // Only echo origin when it is allowed (avoid wildcard when not desired)
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    // Always set these for preflight and normal responses
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin,Content-Type,Authorization,Accept,X-Requested-With');
    // set to 'true' only if you actually use credentials (cookies, etc.)
    res.setHeader('Access-Control-Allow-Credentials', 'false');
    // Tell caches that the response varies by Origin
    res.setHeader('Vary', 'Origin');
  } catch (e) {
    // ignore header-setting errors
    console.warn('setCorsHeaders middleware error', e && e.message ? e.message : e);
  }
  next();
}

// ---------------------------
// 1) Request logger (first, so we see OPTIONS/preflight)
// ---------------------------
app.use((req, res, next) => {
  console.log(`[req] ${new Date().toISOString()} ${req.method} ${req.originalUrl} origin=${req.headers.origin || 'no-origin'}`);
  next();
});

// ---------------------------
// 2) Early CORS header fallback (always runs)
// ---------------------------
app.use(setCorsHeaders);

// ---------------------------
// 3) Apply CORS middleware (for robust handling and preflight validation)
// ---------------------------
app.use(cors(corsOptions));

// ---------------------------
// 4) Explicitly respond to OPTIONS for all routes (helps serverless / edge cases)
//    This is placed before body parsers so preflight returns quickly.
// ---------------------------
app.options('*', (req, res) => {
  // headers have already been set by setCorsHeaders and cors()
  return res.status(corsOptions.optionsSuccessStatus || 204).end();
});

// ---------------------------
// 5) Body parsing (we won't parse multipart here)
// ---------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Writable directories for serverless runtime =====
const RUNTIME_TMP = process.env.TMPDIR || '/tmp';
const uploadsDir = path.join(RUNTIME_TMP, 'uploads');
const tmpDirRoot = path.join(RUNTIME_TMP, 'work');
fs.ensureDirSync(uploadsDir);
fs.ensureDirSync(tmpDirRoot);

// Multer storage (writes to /tmp/...)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// Static bundled file paths (include via vercel.json includeFiles)
const TEMPLATE_VIDEO = path.join(__dirname, '..', 'media', 'certificate_vid_mu.mp4');
const FONT_FILE = path.join(__dirname, '..', 'media', 'Montserrat-Bold.ttf');

const CANVAS_W = 1240;
const CANVAS_H = 1748;
function sanitizeForDrawText(s) {
  if (!s) return '';
  return s.replace(/[:"]/g, '');
}

// Log ffmpeg version (helpful)
execFile(ffmpegStatic, ['-version'], (err, stdout, stderr) => {
  if (err) {
    console.warn('Could not run ffmpeg -version check', err);
  } else {
    const out = (stdout || '').split('\n').slice(0,6).join('\n');
    console.log('ffmpeg -version (top lines):\n' + out);
    if (/freetype|libfreetype/i.test(stdout + stderr)) {
      console.log('ffmpeg appears to include freetype (drawtext likely works).');
    } else {
      console.warn('⚠ ffmpeg may NOT include freetype (drawtext might fail).');
    }
  }
});

// Simple root health route
app.get('/', (req, res) => {
  res.send('✅ Backend is running successfully!');
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.post('/generate', upload.single('photo'), async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${requestId}] POST /generate start`);

  const workDir = path.join(tmpDirRoot, requestId);
  await fs.ensureDir(workDir);

  try {
    const nameRaw = (req.body.name || '').toString();
    const name = sanitizeForDrawText(nameRaw.toUpperCase().trim());

    if (!req.file) {
      await fs.remove(workDir);
      console.log(`[${requestId}] missing photo`);
      return res.status(400).json({ error: 'Photo is required (field name: photo)' });
    }
    if (!name) {
      await fs.remove(workDir);
      console.log(`[${requestId}] missing name`);
      return res.status(400).json({ error: 'Name is required' });
    }

    if (!await fs.pathExists(TEMPLATE_VIDEO)) {
      await fs.remove(workDir);
      console.error(`[${requestId}] Template video missing at ${TEMPLATE_VIDEO}`);
      return res.status(500).json({ error: 'Template video missing on server' });
    }
    if (!await fs.pathExists(FONT_FILE)) {
      await fs.remove(workDir);
      console.error(`[${requestId}] Font file missing at ${FONT_FILE}`);
      return res.status(500).json({ error: 'Font file missing on server' });
    }

    const uploadedPath = req.file.path;
    const fontCopyPath = path.join(workDir, 'Montserrat-Bold.ttf');
    await fs.copy(FONT_FILE, fontCopyPath);

    // Create circular overlay
    const targetSize = 600;
    const overlayPng = path.join(workDir, 'overlay_600.png');

    const circleSvg = `
      <svg width="${targetSize}" height="${targetSize}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${targetSize/2}" cy="${targetSize/2}" r="${targetSize/2}" fill="#fff"/>
      </svg>`;
    const borderSvg = `
      <svg width="${targetSize}" height="${targetSize}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${targetSize/2}" cy="${targetSize/2}" r="${targetSize/2 - 5}"
          fill="none" stroke="#ff9933" stroke-width="10"/>
      </svg>`;

    const inputBuffer = await fs.readFile(uploadedPath);
    await sharp(inputBuffer)
      .resize({ width: targetSize, height: targetSize, fit: 'cover' })
      .composite([
        { input: Buffer.from(circleSvg), blend: 'dest-in' },
        { input: Buffer.from(borderSvg), blend: 'over' }
      ])
      .png()
      .toFile(overlayPng);

    const overlayX = 620 - 300;
    const overlayY = 425 - 300;

    let fontPathForFF = fontCopyPath.replace(/\\/g, '/');
    const fontPathEscapedForFilter = fontPathForFF.replace(/:/g, '\\:').replace(/'/g, "\\'");
    const safeName = name.replace(/'/g, "\\'");
    const drawText = `drawtext=fontfile='${fontPathEscapedForFilter}':text='${safeName}':fontcolor=#274245:fontsize=70:x=620-text_w/2:y=820`;

    const filterComplex =
      `[0:v]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease,` +
      `pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[base];` +
      `[1:v]format=rgba[ovr];` +
      `[base][ovr]overlay=${overlayX}:${overlayY}:format=auto[tmp];` +
      `[tmp]${drawText},format=yuv420p[v]`;

    const outputPath = path.join(workDir, 'output.mp4');

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(TEMPLATE_VIDEO)
        .input(overlayPng)
        .complexFilter(filterComplex)
        .outputOptions([
          '-map', '[v]',
          '-map', '0:a?',
          '-c:v', 'libx264',
          '-crf', '18',
          '-preset', 'veryfast',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-movflags', '+faststart',
          '-shortest'
        ])
        .on('stderr', line => { if (line && line.trim()) console.log(`[ffmpeg ${requestId}] ${line}`); })
        .on('error', (err, stdout, stderr) => {
          console.error(`[${requestId}] ffmpeg error:`, err && err.message ? err.message : err);
          reject(new Error(stderr || err.message || 'ffmpeg error'));
        })
        .on('end', () => {
          console.log(`[${requestId}] ffmpeg finished -> ${outputPath}`);
          resolve();
        })
        .save(outputPath);
    });

    // Ensure CORS header is present just before sending file
    try {
      const origin = (req && req.headers && req.headers.origin) || null;
      if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    } catch (e) { /* ignore */ }

    // send file
    res.download(outputPath, 'My_Certificate.mp4', async (err) => {
      try { await fs.remove(workDir); } catch (e) { console.warn('cleanup workDir failed', e); }
      try { if (await fs.pathExists(uploadedPath)) await fs.remove(uploadedPath); } catch(e) { /* ignore */ }
      if (err) {
        console.error(`[${requestId}] download error`, err);
      } else {
        console.log(`[${requestId}] download served`);
      }
    });

  } catch (err) {
    console.error('generate error', err && err.message ? err.message : err);
    await fs.remove(workDir).catch(()=>{});
    // Make sure we always send JSON so client can parse error.
    // Also ensure CORS header present on error responses:
    try {
      const origin = (req && req.headers && req.headers.origin) || null;
      if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    } catch (e) {
      // ignore
    }
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// Global error handler (catches any uncaught errors in middleware chain)
app.use((err, req, res, next) => {
  console.error('Unhandled error middleware:', err && err.stack ? err.stack : err);
  try {
    const origin = (req && req.headers && req.headers.origin) || null;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  } catch (e) { /* ignore */ }
  res.status(500).json({ error: err && err.message ? err.message : 'Server error' });
});

// Export for Vercel / local
if (process.env.VERCEL) {
  module.exports = app;
} else {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

// Optional: catch unhandled rejections to avoid silent failures
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});
