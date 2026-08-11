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

  const { idToken, email, senha, nome, grupos } = req.body || {};

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
      return res.status(403).json({ error: 'Só administradores podem criar usuários' });
    }

    // 2. Valida os campos
    if (!email || !senha || !nome || !Array.isArray(grupos) || grupos.length === 0) {
      return res.status(400).json({ error: 'Faltam campos obrigatórios (e-mail, senha, nome e ao menos um grupo)' });
    }
    if (senha.length < 6) {
      return res.status(400).json({ error: 'Senha precisa ter pelo menos 6 caracteres' });
    }

    // 3. Cria a conta no Firebase Auth
    const novoUsuario = await admin.auth().createUser({
      email,
      password: senha,
      displayName: nome,
    });

    // 4. Cria o registro de permissão no Realtime Database
    await admin.database()
      .ref('centralApps/usuarios/' + novoUsuario.uid)
      .set({ nome, email, grupos, admin: false });

    return res.status(200).json({ ok: true, uid: novoUsuario.uid });
  } catch (err) {
    const msg = err.code === 'auth/email-already-exists'
      ? 'Já existe uma conta com esse e-mail'
      : (err.message || 'Erro desconhecido');
    return res.status(500).json({ error: msg });
  }
}
