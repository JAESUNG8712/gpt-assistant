const express = require('express');
const path    = require('path');
const router  = express.Router();
const od      = require('../services/onedrive');

const DATA_DIR = path.join(__dirname, '..', 'data');

// 요청 헤더에서 Bearer 토큰 추출
function getToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) throw new Error('Authorization 헤더에 토큰이 없습니다');
  return token;
}

// GET /onedrive/user  — 로그인된 사용자 정보
router.get('/user', async (req, res) => {
  try {
    const info = await od.getUserInfo(getToken(req));
    res.json({ ok: true, user: { name: info.displayName, email: info.mail || info.userPrincipalName } });
  } catch (e) { res.status(401).json({ error: e.message }); }
});

// GET /onedrive/files  — OneDrive AI-Assistant 폴더 목록
router.get('/files', async (req, res) => {
  try {
    const files = await od.listFiles(getToken(req));
    res.json({ ok: true, files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /onedrive/push  — PC → OneDrive 업로드
router.post('/push', async (req, res) => {
  try {
    const results = await od.syncToOneDrive(getToken(req), DATA_DIR);
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /onedrive/pull  — OneDrive → PC 다운로드
router.post('/pull', async (req, res) => {
  try {
    const results = await od.syncFromOneDrive(getToken(req), DATA_DIR);
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
