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

  const { password, title, category, description, filename, fileBase64 } = req.body || {};

  if (!password || password !== process.env.TEAM_PASSWORD) {
    return res.status(401).json({ error: 'Senha incorreta' });
  }
  if (!title || !filename || !fileBase64) {
    return res.status(400).json({ error: 'Faltam campos obrigatórios' });
  }
  if (!filename.toLowerCase().endsWith('.html')) {
    return res.status(400).json({ error: 'Só arquivos .html são aceitos' });
  }

  const OWNER = 'habermann7';
  const REPO = 'central-de-apps';
  const BRANCH = 'main';
  const token = process.env.GITHUB_TOKEN;
  const COLORS = ['#4d9fff', '#ff8a3d', '#ff6b5b', '#3ecf8e', '#c084fc', '#ffd54d'];
  const cleanName = filename.replace(/[^a-zA-Z0-9.\-_ ]/g, '_');

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };

  try {
    // 1. Sobe o arquivo .html do app (cria ou substitui)
    let existingSha;
    const existingRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(cleanName)}?ref=${BRANCH}`,
      { headers: ghHeaders }
    );
    if (existingRes.ok) {
      const existingData = await existingRes.json();
      existingSha = existingData.sha;
    }

    const putFileBody = { message: `Adiciona app: ${title}`, content: fileBase64, branch: BRANCH };
    if (existingSha) putFileBody.sha = existingSha;

    const putFileRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(cleanName)}`,
      { method: 'PUT', headers: ghHeaders, body: JSON.stringify(putFileBody) }
    );
    if (!putFileRes.ok) {
      const err = await putFileRes.json().catch(() => ({}));
      throw new Error(err.message || 'Falha ao salvar o arquivo do app');
    }

    // 2. Atualiza o manifest.json
    const manifestRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/manifest.json?ref=${BRANCH}`,
      { headers: ghHeaders }
    );
    let apps = [];
    let manifestSha;
    if (manifestRes.ok) {
      const manifestData = await manifestRes.json();
      manifestSha = manifestData.sha;
      try {
        apps = JSON.parse(Buffer.from(manifestData.content, 'base64').toString('utf-8'));
      } catch (e) { apps = []; }
    }
    if (!Array.isArray(apps)) apps = [];

    apps.push({
      title,
      category: category || '',
      description: description || '',
      file: cleanName,
      icon: '🧩',
      color: COLORS[apps.length % COLORS.length]
    });

    const newManifestContent = Buffer.from(JSON.stringify(apps, null, 2), 'utf-8').toString('base64');
    const putManifestBody = { message: `Atualiza manifest: adiciona ${title}`, content: newManifestContent, branch: BRANCH };
    if (manifestSha) putManifestBody.sha = manifestSha;

    const putManifestRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/manifest.json`,
      { method: 'PUT', headers: ghHeaders, body: JSON.stringify(putManifestBody) }
    );
    if (!putManifestRes.ok) {
      const err = await putManifestRes.json().catch(() => ({}));
      throw new Error(err.message || 'Falha ao atualizar a lista de apps');
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro desconhecido' });
  }
}
