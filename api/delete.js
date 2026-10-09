import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
    databaseURL: 'https://stinpharma-qualidade-default-rtdb.firebaseio.com',
  });
}

// Confirma que quem chamou está logado E é administrador (mesmo esquema do atualizar-app.js).
async function checarAdmin(idToken) {
  if (!idToken) return { ok: false, status: 401, error: 'Não autenticado' };
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const snap = await admin.database().ref('centralApps/usuarios/' + decoded.uid + '/admin').once('value');
    if (snap.val() !== true) return { ok: false, status: 403, error: 'Só administradores podem fazer isso' };
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 401, error: 'Sessão inválida. Entre de novo na Estante.' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { idToken, filename } = req.body || {};

  const auth = await checarAdmin(idToken);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  if (!filename) {
    return res.status(400).json({ error: 'Falta o nome do arquivo' });
  }

  const OWNER = 'habermann7';
  const REPO = 'central-de-apps';
  const BRANCH = 'main';
  const token = process.env.GITHUB_TOKEN;

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };

  try {
    // 1. Remove a entrada do manifest.json
    const manifestRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/manifest.json?ref=${BRANCH}`,
      { headers: ghHeaders }
    );
    if (!manifestRes.ok) throw new Error('Não consegui ler o manifest.json');
    const manifestData = await manifestRes.json();

    let apps = [];
    try {
      apps = JSON.parse(Buffer.from(manifestData.content, 'base64').toString('utf-8'));
    } catch (e) { apps = []; }
    if (!Array.isArray(apps)) apps = [];

    const before = apps.length;
    apps = apps.filter(a => a.file !== filename);
    if (apps.length === before) {
      return res.status(404).json({ error: 'Esse app não está no manifest' });
    }

    const newManifestContent = Buffer.from(JSON.stringify(apps, null, 2), 'utf-8').toString('base64');
    const putManifestRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/manifest.json`,
      {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify({
          message: `Remove app: ${filename}`,
          content: newManifestContent,
          branch: BRANCH,
          sha: manifestData.sha
        })
      }
    );
    if (!putManifestRes.ok) {
      const err = await putManifestRes.json().catch(() => ({}));
      throw new Error(err.message || 'Falha ao atualizar a lista de apps');
    }

    // 2. Apaga o arquivo .html do app, se ele existir
    const fileRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(filename)}?ref=${BRANCH}`,
      { headers: ghHeaders }
    );
    if (fileRes.ok) {
      const fileData = await fileRes.json();
      await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(filename)}`,
        {
          method: 'DELETE',
          headers: ghHeaders,
          body: JSON.stringify({
            message: `Remove arquivo: ${filename}`,
            sha: fileData.sha,
            branch: BRANCH
          })
        }
      );
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro desconhecido' });
  }
}
