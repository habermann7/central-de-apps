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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { idToken, uid } = req.body || {};
  if (!idToken) return res.status(401).json({ error: 'Não autenticado' });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerSnap = await admin.database()
      .ref('centralApps/usuarios/' + decoded.uid + '/admin')
      .once('value');
    if (callerSnap.val() !== true) {
      return res.status(403).json({ error: 'Só administradores podem fazer isso' });
    }

    if (!uid) return res.status(400).json({ error: 'Falta o usuário' });
    if (decoded.uid === uid) {
      return res.status(400).json({ error: 'Você não pode excluir a sua própria conta.' });
    }
    // apaga o login (Authentication) — se já não existir, segue em frente
    try { await admin.auth().deleteUser(uid); }
    catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
    // apaga o cadastro (grupos/permissões)
    await admin.database().ref('centralApps/usuarios/' + uid).remove();
    return res.status(200).json({ ok: true });
  } catch (err) {
    const msg = err.code === 'auth/user-not-found' ? 'Usuário não encontrado'
      : (err.message || 'Erro desconhecido');
    return res.status(500).json({ error: msg });
  }
}
