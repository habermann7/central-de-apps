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

// Chave "limpa" do grupo (sem acento, maiúscula, sem espaço): "Expedição" -> "EXPEDICAO".
// As regras do Firebase usam esse mapa pra saber de que grupos a pessoa faz parte.
function chaveGrupo(g) {
  return String(g).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim()
    .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function mapaDeGrupos(grupos) {
  const m = {};
  (grupos || []).forEach((g) => { const k = chaveGrupo(g); if (k) m[k] = true; });
  return m;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { idToken } = req.body || {};
  if (!idToken) return res.status(401).json({ error: 'Não autenticado' });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerSnap = await admin.database()
      .ref('centralApps/usuarios/' + decoded.uid + '/admin').once('value');
    if (callerSnap.val() !== true) {
      return res.status(403).json({ error: 'Só administradores podem rodar isso' });
    }

    // Uso único: preenche o "mapa de grupos" de todo mundo que já existe.
    const snap = await admin.database().ref('centralApps/usuarios').once('value');
    const todos = snap.val() || {};
    const updates = {};
    const resumo = [];
    Object.keys(todos).forEach((uid) => {
      const u = todos[uid] || {};
      const mapa = mapaDeGrupos(u.grupos);
      updates['centralApps/usuarios/' + uid + '/gruposMap'] = Object.keys(mapa).length ? mapa : null;
      resumo.push((u.nome || u.email || uid) + ': ' + (Object.keys(mapa).join(', ') || 'sem grupo') + (u.admin === true ? ' (admin)' : ''));
    });
    if (Object.keys(updates).length) await admin.database().ref().update(updates);

    return res.status(200).json({ ok: true, usuarios: resumo.length, resumo });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro desconhecido' });
  }
}
