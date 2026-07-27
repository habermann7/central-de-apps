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

  const { password, filename } = req.body || {};

  if (!password || password !== process.env.TEAM_PASSWORD) {
    return res.status(401).json({ error: 'Senha incorreta' });
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
