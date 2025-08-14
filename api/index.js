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

// ✅ CORS setup with your actual frontend URL
app.use(cors({
  origin: [
    'http://localhost:3000', // local dev
    'https://vercel-frontend-sigma-nine.vercel.app' // your deployed frontend
  ]
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Writable directories for Vercel =====
const RUNTIME_TMP = process.env.TMPDIR || '/tmp';
const uploadsDir = path.join(RUNTIME_TMP, 'uploads');
const tmpDirRoot = path.join(RUNTIME_TMP, 'work');
fs.ensureDirSync(uploadsDir);
fs.ensureDirSync(tmpDirRoot);

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// Static bundled file paths
const TEMPLATE_VIDEO = path.join(__dirname, '..', 'media', 'certificate_vid_mu.mp4');
const FONT_FILE = path.join(__dirname, '..', 'media', 'Montserrat-Bold.ttf');

const CANVAS_W = 1240;
const CANVAS_H = 1748;

function sanitizeForDrawText(s) {
  if (!s) return '';
  return s.replace(/[:"]/g, '');
}

// Optional: ffmpeg version check
execFile(ffmpegStatic, ['-version'], (err, stdout, stderr) => {
  if (err) {
    console.warn('Could not run ffmpeg -version check', err);
  } else {
    const outLines = (stdout || '').split('\n').slice(0, 6).join('\n');
    console.log('ffmpeg -version (top lines):\n' + outLines);
    if (/freetype|libfreetype/i.test(stdout + stderr)) {
      console.log('ffmpeg includes freetype (drawtext should work).');
    } else {
      console.warn('⚠ ffmpeg may not have freetype — drawtext might fail.');
    }
  }
});

// ✅ Root route for quick test
app.get('/', (req, res) => {
  res.send('✅ Backend is running successfully!');
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.post('/generate', upload.single('photo'), async (req, res) => {
  const requestId = uuidv4();
  const workDir = path.join(tmpDirRoot, requestId);
  await fs.ensureDir(workDir);

  try {
    const nameRaw = (req.body.name || '').toString();
    const name = sanitizeForDrawText(nameRaw.toUpperCase().trim());

    if (!req.file) {
      await fs.remove(workDir);
      return res.status(400).json({ error: 'Photo is required (field name: photo)' });
    }
    if (!name) {
      await fs.remove(workDir);
      return res.status(400).json({ error: 'Name is required' });
    }

    if (!await fs.pathExists(TEMPLATE_VIDEO)) {
      await fs.remove(workDir);
      return res.status(500).json({ error: 'Template video missing on server' });
    }
    if (!await fs.pathExists(FONT_FILE)) {
      await fs.remove(workDir);
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

    // Prepare drawtext
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
        .on('error', (err, stdout, stderr) => {
          reject(new Error(`ffmpeg error: ${stderr || err.message}`));
        })
        .on('end', () => resolve())
        .save(outputPath);
    });

    res.download(outputPath, 'My_Certificate.mp4', async () => {
      await fs.remove(workDir);
      await fs.remove(uploadedPath).catch(() => {});
    });

  } catch (err) {
    console.error('generate error', err);
    await fs.remove(workDir).catch(() => {});
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ✅ Export for Vercel / Local run
if (process.env.VERCEL) {
  module.exports = app; // Vercel handles serverless
} else {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
