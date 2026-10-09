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

  const { idToken, title, description, filename, fileBase64, grupos } = req.body || {};

  const auth = await checarAdmin(idToken);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
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
  const COR_PADRAO = '#4d9fff';
  const cleanName = filename.replace(/[^a-zA-Z0-9.\-_ ]/g, '_');
  const gruposFinal = Array.isArray(grupos) && grupos.length ? grupos : ['Geral'];

  // Cadeado de login+grupo. Só libera o conteúdo se a pessoa estiver logada (Firebase Auth)
  // E estiver num dos grupos abaixo (ou for admin). O login acontece na Estante.
  // A parte de cima (tela "Verificando acesso") vai logo depois do <body>, pra página
  // não "piscar" aberta; a parte de baixo (a lógica) vai antes do </body>.
  const gateTop = `
<div id="__gateOverlay" style="position:fixed;inset:0;z-index:2147483647;background:#0a0d12;color:#eef1f5;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;text-align:center;padding:20px;">
  <div style="max-width:320px;width:100%;">
    <div id="__gateMsg" style="font-size:14px;color:#8a93a3;line-height:1.6;">Verificando acesso...</div>
  </div>
</div>
`;
  const gateBottom = `
<script src="https://cdnjs.cloudflare.com/ajax/libs/firebase/12.16.0/firebase-app-compat.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/firebase/12.16.0/firebase-auth-compat.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/firebase/12.16.0/firebase-database-compat.min.js"></script>
<script>
(function(){
  /* CADEADO PADRÃO DA ESTANTE. Só esta linha muda (o ✎ Editar troca ela). */
  var GRUPOS_PERMITIDOS = ${JSON.stringify(gruposFinal)};
  var firebaseConfig = {
    apiKey: "AIzaSyCpG7o-CF3twF0Jti0bRchrS97SWYQBuyo",
    authDomain: "stinpharma-qualidade.firebaseapp.com",
    databaseURL: "https://stinpharma-qualidade-default-rtdb.firebaseio.com",
    projectId: "stinpharma-qualidade",
    storageBucket: "stinpharma-qualidade.firebasestorage.app",
    messagingSenderId: "422803826984",
    appId: "1:422803826984:web:6e72e2470f3678eb8d881d",
    measurementId: "G-6C0TLHH2VP"
  };
  if(!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  function norm(x){ return String(x).normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").toUpperCase().trim(); }
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
  function liberar(){
    var st = document.getElementById('__gateStyle');
    var ov = document.getElementById('__gateOverlay');
    if(st) st.remove();
    if(ov) ov.remove();
    window.__gateOk = true;
    if(window.__startApp) window.__startApp();
  }
  function negar(msg){
    document.getElementById('__gateMsg').innerHTML = msg + '<br><br><a href="./index.html" style="color:#4d9fff;">&larr; Voltar pra Estante</a>';
  }
  var jaResolveu = false;
  setTimeout(function(){
    if(!jaResolveu) negar('Não foi possível confirmar seu acesso (conexão lenta ou instável). <a href="javascript:location.reload()" style="color:#4d9fff;">Tentar de novo</a>');
  }, 10000);
  firebase.auth().onAuthStateChanged(function(user){
    jaResolveu = true;
    if(!user){ negar('Você precisa entrar pela Estante.'); return; }
    firebase.database().ref('centralApps/usuarios/' + user.uid).once('value').then(function(snap){
      var dados = snap.val() || {};
      var meus = (dados.grupos || []).map(norm);
      var permitido = dados.admin === true || GRUPOS_PERMITIDOS.some(function(g){ return meus.indexOf(norm(g)) !== -1; });
      if(permitido){ liberar(); return; }
      negar('Você não tem permissão pra acessar este app.<br><span style="font-size:12px;">Seus grupos: ' + esc((dados.grupos||[]).join(', ') || 'nenhum') + '<br>Grupos com acesso: ' + esc(GRUPOS_PERMITIDOS.join(', ')) + '</span>');
    }).catch(function(){ negar('Não foi possível checar sua permissão agora. Tente recarregar.'); });
  });
})();
</script>
`;

  const htmlContent = Buffer.from(fileBase64, 'base64').toString('utf-8');
  const gruposRegex = /var GRUPOS_PERMITIDOS = \[[^\]]*\];/;
  let injectedHtml;
  if (gruposRegex.test(htmlContent)) {
    // O arquivo já tem o cadeado: só atualiza a lista de grupos, sem duplicar nada.
    injectedHtml = htmlContent.replace(gruposRegex, `var GRUPOS_PERMITIDOS = ${JSON.stringify(gruposFinal)};`);
  } else {
    injectedHtml = /<body[^>]*>/i.test(htmlContent)
      ? htmlContent.replace(/<body[^>]*>/i, (m) => m + gateTop)
      : gateTop + htmlContent;
    injectedHtml = /<\/body>/i.test(injectedHtml)
      ? injectedHtml.replace(/<\/body>/i, () => gateBottom + '</body>')
      : injectedHtml + gateBottom;
  }
  const finalFileBase64 = Buffer.from(injectedHtml, 'utf-8').toString('base64');

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

    const putFileBody = { message: `Adiciona app: ${title}`, content: finalFileBase64, branch: BRANCH };
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

    // Cor = a mesma dos outros apps da mesma prateleira (primeiro grupo). Sem sorteio.
    const primeiroGrupo = gruposFinal[0];
    const irmao = apps.find(a => a && a.file !== cleanName && Array.isArray(a.grupos) && a.grupos[0] === primeiroGrupo && a.color);
    const cor = irmao ? irmao.color : COR_PADRAO;

    const idxExistente = apps.findIndex(a => a && a.file === cleanName);
    if (idxExistente !== -1) {
      // Reenvio do mesmo arquivo: atualiza a entrada em vez de duplicar na lista.
      apps[idxExistente] = {
        ...apps[idxExistente],
        title,
        description: description || '',
        grupos: gruposFinal
      };
    } else {
      apps.push({
        title,
        description: description || '',
        file: cleanName,
        icon: '🧩',
        color: cor,
        grupos: gruposFinal
      });
    }

    const newManifestContent = Buffer.from(JSON.stringify(apps, null, 2), 'utf-8').toString('base64');
    const putManifestBody = { message: `Atualiza manifest: ${title}`, content: newManifestContent, branch: BRANCH };
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
