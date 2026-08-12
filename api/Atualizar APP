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

  const { idToken, filename, title, category, description, grupos } = req.body || {};

  if (!idToken) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  try {
    // 1. Confirma que quem está chamando é realmente um administrador
    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerSnap = await admin.database()
      .ref('centralApps/usuarios/' + decoded.uid + '/admin')
      .once('value');
    if (callerSnap.val() !== true) {
      return res.status(403).json({ error: 'Só administradores podem editar apps' });
    }

    // 2. Valida os campos
    if (!filename || !title || !Array.isArray(grupos) || grupos.length === 0) {
      return res.status(400).json({ error: 'Faltam campos obrigatórios (arquivo, título e ao menos um grupo)' });
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

    // 3. Busca o arquivo atual do app no repositório
    const fileRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(filename)}?ref=${BRANCH}`,
      { headers: ghHeaders }
    );
    if (!fileRes.ok) {
      throw new Error('Arquivo do app não encontrado no repositório');
    }
    const fileData = await fileRes.json();
    const htmlContent = Buffer.from(fileData.content, 'base64').toString('utf-8');

    // 4. Troca a lista de grupos permitidos dentro do cadeado já injetado no arquivo
    const regex = /var GRUPOS_PERMITIDOS = \[[^\]]*\];/;
    if (!regex.test(htmlContent)) {
      throw new Error('Não encontrei o cadeado de grupo neste arquivo. Ele precisa ter sido publicado pela Central de Apps (upload.js) pra ter esse trecho.');
    }
    const novoHtml = htmlContent.replace(regex, `var GRUPOS_PERMITIDOS = ${JSON.stringify(grupos)};`);
    const novoConteudoBase64 = Buffer.from(novoHtml, 'utf-8').toString('base64');

    const putFileRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(filename)}`,
      {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify({
          message: `Atualiza permissões: ${title}`,
          content: novoConteudoBase64,
          sha: fileData.sha,
          branch: BRANCH
        })
      }
    );
    if (!putFileRes.ok) {
      const err = await putFileRes.json().catch(() => ({}));
      throw new Error(err.message || 'Falha ao atualizar o arquivo do app');
    }

    // 5. Atualiza a entrada correspondente no manifest.json
    const manifestRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/manifest.json?ref=${BRANCH}`,
      { headers: ghHeaders }
    );
    if (!manifestRes.ok) {
      throw new Error('Não consegui ler o manifest.json');
    }
    const manifestData = await manifestRes.json();
    let apps = [];
    try {
      apps = JSON.parse(Buffer.from(manifestData.content, 'base64').toString('utf-8'));
    } catch (e) {
      apps = [];
    }
    if (!Array.isArray(apps)) apps = [];

    const idx = apps.findIndex(a => a.file === filename);
    if (idx === -1) {
      throw new Error('App não encontrado no manifest.json');
    }

    apps[idx] = {
      ...apps[idx],
      title,
      category: category || '',
      description: description || '',
      grupos
    };

    const newManifestBase64 = Buffer.from(JSON.stringify(apps, null, 2), 'utf-8').toString('base64');
    const putManifestRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/manifest.json`,
      {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify({
          message: `Atualiza manifest: ${title}`,
          content: newManifestBase64,
          sha: manifestData.sha,
          branch: BRANCH
        })
      }
    );
    if (!putManifestRes.ok) {
      const err = await putManifestRes.json().catch(() => ({}));
      throw new Error(err.message || 'Falha ao atualizar o manifest.json');
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro desconhecido' });
  }
}
