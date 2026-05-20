const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sync = require('../services/sync');

// File upload to sync dir
const upload = multer({
  dest: path.join(__dirname, '..', 'sync', 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// GET /sync/status
router.get('/status', (req, res) => {
  res.json({
    meta: sync.getMeta(),
    files: sync.getSyncFiles(),
    syncDir: sync.SYNC_DIR,
  });
});

// POST /sync/export  — export PC knowledge to sync folder
router.post('/export', async (req, res) => {
  try {
    const result = sync.exportPC();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /sync/download/:filename  — download a sync file
router.get('/download/:filename', (req, res) => {
  const allowed = ['pc-knowledge.json', 'pc-knowledge.md', 'ipad-system-prompt.txt'];
  const { filename } = req.params;
  if (!allowed.includes(filename)) return res.status(403).json({ error: '허용되지 않은 파일' });

  const filePath = path.join(sync.SYNC_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '파일 없음. 먼저 내보내기를 실행하세요.' });

  res.download(filePath, filename);
});

// POST /sync/import  — upload iPad export file and import
router.post('/import', upload.single('file'), async (req, res) => {
  try {
    let filePath = sync.IPAD_IMPORT_FILE;

    if (req.file) {
      // Rename uploaded file
      fs.mkdirSync(path.dirname(sync.IPAD_IMPORT_FILE), { recursive: true });
      fs.renameSync(req.file.path, sync.IPAD_IMPORT_FILE);
      filePath = sync.IPAD_IMPORT_FILE;
    }

    const result = await sync.importIPad(filePath);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
