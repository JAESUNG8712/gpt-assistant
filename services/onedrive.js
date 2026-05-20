// OneDrive sync via Microsoft Graph API (Node.js server side)
// Uses access token obtained from browser MSAL login

const fs   = require('fs');
const path = require('path');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const FOLDER = 'AI-Assistant';         // OneDrive 폴더 이름

// ── Graph API helper ──────────────────────────────────────────────────────────
async function graph(token, endpoint, { method = 'GET', body } = {}) {
  const res = await fetch(`${GRAPH}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Graph ${res.status}: ${err}`);
  }
  return res;
}

// ── Upload a file to OneDrive:/AI-Assistant/filename ─────────────────────────
async function upload(token, filename, data) {
  const content = typeof data === 'string' ? data : JSON.stringify(data);
  await graph(token, `/me/drive/root:/${FOLDER}/${filename}:/content`, {
    method: 'PUT',
    body: content,
  });
}

// ── Download a file from OneDrive ─────────────────────────────────────────────
async function download(token, filename) {
  const res = await graph(token, `/me/drive/root:/${FOLDER}/${filename}:/content`);
  return res.json();
}

// ── Check if file exists in OneDrive ─────────────────────────────────────────
async function exists(token, filename) {
  try {
    await graph(token, `/me/drive/root:/${FOLDER}/${filename}`);
    return true;
  } catch { return false; }
}

// ── List files in AI-Assistant folder ────────────────────────────────────────
async function listFiles(token) {
  try {
    const res = await graph(token, `/me/drive/root:/${FOLDER}:/children`);
    const data = await res.json();
    return (data.value || []).map(f => ({
      name: f.name,
      size: f.size,
      modified: f.lastModifiedDateTime,
    }));
  } catch { return []; }
}

// ── Get OneDrive user info ────────────────────────────────────────────────────
async function getUserInfo(token) {
  const res = await graph(token, '/me');
  return res.json();
}

// ── Sync PC files → OneDrive ──────────────────────────────────────────────────
async function syncToOneDrive(token, dataDir) {
  const files = {
    'minigpt-weights.json': path.join(dataDir, 'minigpt-weights.json'),
    'minigpt-log.json':     path.join(dataDir, 'minigpt-log.json'),
    'knowledge.json':       path.join(dataDir, 'knowledge.json'),
  };

  const results = [];
  for (const [remote, local] of Object.entries(files)) {
    if (!fs.existsSync(local)) continue;
    try {
      const content = fs.readFileSync(local, 'utf8');
      await upload(token, remote, content);
      const stat = fs.statSync(local);
      results.push({ file: remote, size: stat.size, status: 'uploaded' });
    } catch (e) {
      results.push({ file: remote, status: 'error', error: e.message });
    }
  }
  return results;
}

// ── Sync OneDrive → PC files ──────────────────────────────────────────────────
async function syncFromOneDrive(token, dataDir) {
  const files = [
    'minigpt-weights.json',
    'minigpt-log.json',
    'knowledge.json',
  ];

  fs.mkdirSync(dataDir, { recursive: true });
  const results = [];
  for (const filename of files) {
    try {
      const data = await download(token, filename);
      const local = path.join(dataDir, filename);
      fs.writeFileSync(local, JSON.stringify(data, null, 2), 'utf8');
      results.push({ file: filename, status: 'downloaded' });
    } catch (e) {
      if (e.message.includes('404')) {
        results.push({ file: filename, status: 'not_found' });
      } else {
        results.push({ file: filename, status: 'error', error: e.message });
      }
    }
  }
  return results;
}

module.exports = {
  upload, download, exists, listFiles, getUserInfo,
  syncToOneDrive, syncFromOneDrive, FOLDER,
};
