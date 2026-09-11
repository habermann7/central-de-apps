// api/atualizar-rastreio.js
//
// Função serverless que roda sozinha (chamada pelo agendamento do vercel.json)
// e atualiza o status dos pedidos pendentes consultando a API dos Correios.
//
// Usa as MESMAS variáveis de ambiente que api/criar-usuario.js já usa:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
//
// Variáveis já cadastradas no Vercel:
//   CORREIOS_CHAVE_ACESSO -> a chave "cws-ch1_..." que você gerou
//   ROBO_SEGREDO           -> uma senha qualquer, só sua, pra proteger essa URL

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

const CAMINHO_PEDIDOS = 'rastreioVipp/pedidos';

const STATUS_ENTREGUE = [
  'Objeto entregue ao destinatário',
  'Objeto entregue ao remetente',
  'Objeto entregue na Caixa de Correios Inteligente',
];

// A API dos Correios pode devolver a data do evento em nomes de campo
// diferentes dependendo da versão. Tentamos os mais comuns, nessa ordem.
function extrairDataEvento(evento) {
  return (
    evento.dtHrCriado ||
    evento.dataHora ||
    evento.data ||
    evento.dtEvento ||
    evento.dataEvento ||
    evento.hora ||
    null
  );
}

function partesDe50(lista) {
  const grupos = [];
  for (let i = 0; i < lista.length; i += 50) {
    grupos.push(lista.slice(i, i + 50));
  }
  return grupos;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-robo-segredo');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const segredoEsperado = process.env.ROBO_SEGREDO;
  const segredoRecebido = req.headers['x-robo-segredo'] || req.query.segredo;
  const autorizacaoHeader = req.headers['authorization'] || '';

  let autorizado = false;

  // caminho 1: chamada automática do cron, com a senha do robô
  if (segredoEsperado && segredoRecebido === segredoEsperado) {
    autorizado = true;
  }

  // caminho 2: clique manual de um usuário logado (botão "Atualizar agora")
  if (!autorizado && autorizacaoHeader.startsWith('Bearer ')) {
    const idToken = autorizacaoHeader.replace('Bearer ', '');
    try {
      await admin.auth().verifyIdToken(idToken);
      autorizado = true;
    } catch (err) {
      // token inválido, segue como não autorizado
    }
  }

  if (!autorizado) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  try {
    const snap = await admin.database().ref(CAMINHO_PEDIDOS).once('value');
    const todos = snap.val() || {};

    const pendentes = Object.keys(todos).filter(
      (chave) => !STATUS_ENTREGUE.includes(todos[chave].status)
    );

    if (pendentes.length === 0) {
      return res.status(200).json({ mensagem: 'Nada pendente pra atualizar', atualizados: 0 });
    }

    // guarda o código de rastreio real de cada chave (pra montar a URL da consulta)
    const codigoPorChave = {};
    pendentes.forEach((chave) => {
      codigoPorChave[chave] = todos[chave].codigo || chave;
    });

    const lotes = partesDe50(pendentes);
    let atualizados = 0;
    const erros = [];
    let amostraUltimoEvento = null; // só pra conferência manual, ver comentário abaixo

    for (const lote of lotes) {
      const codigos = lote.map((chave) => codigoPorChave[chave]);
      // Os códigos vão no caminho da URL (path), não como parâmetro de query —
      // essa é a convenção documentada da API dos Correios.
      const url =
        'https://api.correios.com.br/srorastro/v1/objetos/' +
        codigos.join(',') +
        '?resultado=U&idioma=pt-BR';

      const resposta = await fetch(url, {
        headers: { Authorization: 'Bearer ' + process.env.CORREIOS_CHAVE_ACESSO },
      });

      if (!resposta.ok) {
        const textoErro = await resposta.text().catch(() => '');
        erros.push('Lote falhou: HTTP ' + resposta.status + (textoErro ? ' — ' + textoErro.slice(0, 300) : ''));
        continue;
      }

      const dados = await resposta.json();
      const objetos = dados.objetos || [];

      const updates = {};
      for (const objeto of objetos) {
        const eventos = objeto.eventos || [];
        if (eventos.length === 0) continue;
        const chave = Object.keys(codigoPorChave).find(
          (k) => codigoPorChave[k] === objeto.codObjeto
        );
        if (!chave) continue;
        const ultimoEvento = eventos[0];
        if (!amostraUltimoEvento) amostraUltimoEvento = ultimoEvento; // guarda o primeiro que aparecer, cru
        updates[CAMINHO_PEDIDOS + '/' + chave + '/status'] = ultimoEvento.descricao;
        const dataEvento = extrairDataEvento(ultimoEvento);
        if (dataEvento) {
          updates[CAMINHO_PEDIDOS + '/' + chave + '/dataEvento'] = dataEvento;
        }
        updates[CAMINHO_PEDIDOS + '/' + chave + '/atualizadoEm'] = Date.now();
        atualizados++;
      }

      if (Object.keys(updates).length > 0) {
        await admin.database().ref().update(updates);
      }
    }

    return res.status(200).json({
      mensagem: 'Atualização concluída',
      totalPendentes: pendentes.length,
      atualizados,
      erros,
      // Isso aqui é só pra conferência: mostra o evento cru que a API dos Correios
      // devolveu, pra confirmar se "dataEvento" pegou o campo certo. Pode remover
      // esse campo do retorno depois de conferir uma vez, se quiser deixar mais limpo.
      amostraUltimoEvento,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
