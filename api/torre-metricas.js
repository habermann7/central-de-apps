import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

// ---- Firebase da Estante (login e permissões) ----
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

// ---- Firebase do Control Tower (só leitura dos chamados) ----
function appTorre() {
  const ja = admin.apps.find((a) => a && a.name === 'torre');
  if (ja) return ja;
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.TORRE_PROJECT_ID,
      clientEmail: process.env.TORRE_CLIENT_EMAIL,
      privateKey: (process.env.TORRE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  }, 'torre');
}

const DIA = 86400000;
const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));

// Mesma regra de nome de grupo usada em toda a Estante (sem acento, maiúsculo, só letras/números)
function chaveGrupo(g) {
  return String(g).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim()
    .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Os grupos que podem ver este painel são os do próprio app (linha GRUPOS_PERMITIDOS,
// a mesma que o ✎ Editar da Estante altera). Assim o servidor e o cadeado sempre concordam.
const ARQUIVO_APP = 'painel_chamados.html';
const URL_APP = 'https://estanteapps.vercel.app/' + ARQUIVO_APP;
let cacheGrupos = { em: 0, lista: null };
async function gruposDoApp() {
  if (cacheGrupos.lista && Date.now() - cacheGrupos.em < 30000) return cacheGrupos.lista;
  const r = await fetch(URL_APP + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('Não consegui ler a configuração do app (' + r.status + ')');
  const html = await r.text();
  const m = html.match(/var GRUPOS_PERMITIDOS = (\[[^\]]*\]);/);
  if (!m) throw new Error('Não achei os grupos permitidos no app');
  const lista = JSON.parse(m[1]).map(chaveGrupo).filter(Boolean);
  cacheGrupos = { em: Date.now(), lista };
  return lista;
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
    // 1. Quem pode ver: admin da Estante ou quem está num dos grupos configurados no app
    const decoded = await admin.auth().verifyIdToken(idToken);
    const snap = await admin.database().ref('centralApps/usuarios/' + decoded.uid).once('value');
    const u = snap.val() || {};
    let ok = u.admin === true;
    if (!ok) {
      const permitidos = await gruposDoApp();
      const meus = u.gruposMap || {};
      ok = permitidos.some((k) => meus[k] === true);
    }
    if (!ok) return res.status(403).json({ error: 'Sem permissão para ver este painel' });

    if (!process.env.TORRE_PROJECT_ID || !process.env.TORRE_CLIENT_EMAIL || !process.env.TORRE_PRIVATE_KEY) {
      return res.status(500).json({ error: 'Chave do Control Tower ainda não configurada no Vercel (TORRE_*)' });
    }

    // 2. Lê os chamados dos últimos 400 dias
    const db = getFirestore(appTorre(), 'default');
    const desde = Date.now() - 400 * DIA;
    const qs = await db.collection('chamados').where('abertoEm', '>=', desde).limit(10000).get();

    // 3. Devolve SÓ campos numéricos/categóricos — sem vendedor, pedido, NF, mensagens ou descrição
    const chamados = qs.docs.map((d) => {
      const c = d.data();
      return {
        n: c.numero ?? null,
        tipo: c.tipo || '—',
        status: c.status || '',
        urgente: c.urgente === true,
        modal: c.modal || '',
        abertoEm: num(c.abertoEm),
        primeiraRespostaEm: num(c.primeiraRespostaEm),
        resolvidoEm: num(c.resolvidoEm),
        pausas: (c.pausas || []).map((p) => ({ inicio: num(p.inicio), fim: num(p.fim) })),
        metaR: num(c.metaR),
        metaS: num(c.metaS),
        causa: c.causa || '',
        tratativa: c.tratativa || '',
        nota: num(c.nota),
        atendente: c.atendenteNome || '',
      };
    }).filter((c) => c.abertoEm);

    return res.status(200).json({ ok: true, geradoEm: Date.now(), total: chamados.length, chamados });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro desconhecido' });
  }
}
