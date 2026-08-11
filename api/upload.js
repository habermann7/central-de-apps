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

  const { password, title, category, description, filename, fileBase64, grupos } = req.body || {};

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
  const gruposFinal = Array.isArray(grupos) && grupos.length ? grupos : ['Geral'];

  // Injeta um cadeado de login+grupo no HTML do app antes de subir.
  // Só libera o conteúdo se a pessoa estiver logada (Firebase Auth) E pertencer
  // a um dos grupos permitidos abaixo. O login em si acontece na Central de Apps.
  const htmlContent = Buffer.from(fileBase64, 'base64').toString('utf-8');
  const gateSnippet = `
<div id="__gateOverlay" style="position:fixed;inset:0;z-index:2147483647;background:#0a0d12;color:#eef1f5;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;text-align:center;padding:20px;">
  <div style="max-width:320px;width:100%;">
    <div id="__gateMsg" style="font-size:14px;color:#8a93a3;line-height:1.6;">Verificando acesso...</div>
  </div>
</div>
<style id="__gateStyle">body > *:not(#__gateOverlay){ display:none !important; }</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/firebase/12.16.0/firebase-app-compat.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/firebase/12.16.0/firebase-auth-compat.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/firebase/12.16.0/firebase-database-compat.min.js"></script>
<script>
(function(){
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
  function liberar(){
    var st = document.getElementById('__gateStyle');
    var ov = document.getElementById('__gateOverlay');
    if(st) st.remove();
    if(ov) ov.remove();
  }
  function negar(msg){
    document.getElementById('__gateMsg').innerHTML = msg + '<br><br><a href="./index.html" style="color:#4d9fff;">&larr; Voltar pra Central de Apps</a>';
  }
  var jaResolveu = false;
  setTimeout(function(){
    if(!jaResolveu) negar('Não foi possível confirmar seu acesso (conexão lenta ou instável). <a href="javascript:location.reload()" style="color:#4d9fff;">Tentar de novo</a>');
  }, 10000);
  firebase.auth().onAuthStateChanged(function(user){
    jaResolveu = true;
    if(!user){ negar('Você precisa entrar pela Central de Apps.'); return; }
    firebase.database().ref('centralApps/usuarios/' + user.uid).once('value').then(function(snap){
      var dados = snap.val();
      var meusGrupos = (dados && dados.grupos) || [];
      var permitido = GRUPOS_PERMITIDOS.some(function(g){ return meusGrupos.indexOf(g) !== -1; });
      if(permitido){ liberar(); } else { negar('Você não tem permissão pra acessar este app.'); }
    }).catch(function(){ negar('Não foi possível checar sua permissão agora. Tente recarregar.'); });
  });
})();
</script>
`;
  const injectedHtml = /<\/body>/i.test(htmlContent)
    ? htmlContent.replace(/<\/body>/i, gateSnippet + '</body>')
    : htmlContent + gateSnippet;
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

    apps.push({
      title,
      category: category || '',
      description: description || '',
      file: cleanName,
      icon: '🧩',
      color: COLORS[apps.length % COLORS.length],
      grupos: gruposFinal
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
