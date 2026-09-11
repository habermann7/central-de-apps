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

// Status que não vão mudar mais — não faz sentido continuar gastando consulta
// com eles. "Entregue" já para de ser consultado (acima); esses aqui também.
const STATUS_MORTOS = [
  'Etiqueta Expirada',
  'Erro Geraçâo PPN',
];

// Se um código falhar (ex: "não localizado") essa quantidade de vezes seguidas,
// para de tentar esse código — provavelmente é lixo (etiqueta nunca postada,
// código digitado errado etc), não vale continuar gastando consulta com ele.
const LIMITE_TENTATIVAS_SEM_SUCESSO = 5;

// A API dos Correios não aceita vários códigos separados por vírgula na mesma
// consulta (confirmado: ela trata a lista toda como se fosse 1 código só e
// devolve "não localizado"). Por isso consultamos um código por vez — em
// paralelo, pra não demorar demais, e em quantidade limitada por execução,
// pra não estourar o tempo máximo que a Vercel dá pra função rodar.
const CONCORRENCIA = 10; // quantas consultas simultâneas por rodada
const LIMITE_POR_EXECUCAO = 250; // máximo de pedidos consultados por clique/execução

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

function partesDe(lista, tamanho) {
  const grupos = [];
  for (let i = 0; i < lista.length; i += tamanho) {
    grupos.push(lista.slice(i, i + tamanho));
  }
  return grupos;
}

async function consultarUmCodigo(codigo) {
  const url =
    'https://api.correios.com.br/srorastro/v1/objetos/' +
    encodeURIComponent(codigo) +
    '?resultado=U&idioma=pt-BR';

  const resposta = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + process.env.CORREIOS_CHAVE_ACESSO,
      'Accept-Language': 'pt-BR',
    },
  });

  if (!resposta.ok) {
    const textoErro = await resposta.text().catch(() => '');
    return { codigo, ok: false, erro: 'HTTP ' + resposta.status + (textoErro ? ' — ' + textoErro.slice(0, 200) : '') };
  }

  const dados = await resposta.json();
  const objetos = dados.objetos || dados.objeto || [];
  const objeto = objetos[0];
  if (!objeto) return { codigo, ok: false, erro: 'resposta sem objeto', dadosCrus: dados };

  const eventos = objeto.eventos || objeto.evento || [];
  if (eventos.length === 0) {
    return { codigo, ok: false, erro: objeto.mensagem || 'sem eventos', dadosCrus: dados };
  }

  return { codigo, ok: true, evento: eventos[0], dadosCrus: dados };
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

    const pendentes = Object.keys(todos).filter((chave) => {
      const p = todos[chave];
      if (STATUS_ENTREGUE.includes(p.status)) return false;
      if (STATUS_MORTOS.includes(p.status)) return false;
      if ((p.tentativasSemSucesso || 0) >= LIMITE_TENTATIVAS_SEM_SUCESSO) return false;
      return true;
    });

    if (pendentes.length === 0) {
      return res.status(200).json({ mensagem: 'Nada pendente pra atualizar', atualizados: 0 });
    }

    // guarda o código de rastreio real de cada chave (pra montar a URL da consulta)
    const codigoPorChave = {};
    pendentes.forEach((chave) => {
      codigoPorChave[chave] = todos[chave].codigo || chave;
    });

    // se tiver mais pendente do que dá pra processar numa execução só, pega só
    // o começo — o resto fica pra o próximo clique ou a próxima rodada do robô
    const paraProcessar = pendentes.slice(0, LIMITE_POR_EXECUCAO);
    const restantes = pendentes.length - paraProcessar.length;

    const rodadas = partesDe(paraProcessar, CONCORRENCIA);
    let atualizados = 0;
    let semEvento = 0;
    const erros = [];
    let amostraUltimoEvento = null; // só pra conferência manual
    let amostraRespostaCrua = null; // idem — resposta crua da 1ª consulta

    for (const rodada of rodadas) {
      const resultados = await Promise.all(
        rodada.map((chave) => consultarUmCodigo(codigoPorChave[chave]).then((r) => ({ chave, ...r })))
      );

      const updates = {};
      for (const r of resultados) {
        if (!amostraRespostaCrua && r.dadosCrus) amostraRespostaCrua = r.dadosCrus;
        if (!r.ok) {
          if (r.erro) semEvento++;
          if (erros.length < 15 && r.erro) erros.push(r.codigo + ': ' + r.erro);
          const tentativasAtuais = (todos[r.chave] && todos[r.chave].tentativasSemSucesso) || 0;
          updates[CAMINHO_PEDIDOS + '/' + r.chave + '/tentativasSemSucesso'] = tentativasAtuais + 1;
          continue;
        }
        if (!amostraUltimoEvento) amostraUltimoEvento = r.evento;
        updates[CAMINHO_PEDIDOS + '/' + r.chave + '/status'] = r.evento.descricao || r.evento.msg || '';
        const dataEvento = extrairDataEvento(r.evento);
        if (dataEvento) {
          updates[CAMINHO_PEDIDOS + '/' + r.chave + '/dataEvento'] = dataEvento;
        }
        updates[CAMINHO_PEDIDOS + '/' + r.chave + '/atualizadoEm'] = Date.now();
        updates[CAMINHO_PEDIDOS + '/' + r.chave + '/tentativasSemSucesso'] = 0;
        atualizados++;
      }

      // grava aos poucos, a cada rodada — se o tempo acabar no meio, o que já
      // foi consultado não se perde
      if (Object.keys(updates).length > 0) {
        await admin.database().ref().update(updates);
      }
    }

    return res.status(200).json({
      mensagem: 'Atualização concluída',
      totalPendentes: pendentes.length,
      processadosNessaExecucao: paraProcessar.length,
      restantes, // se > 0, clica em "Atualizar agora" de novo pra continuar
      atualizados,
      semEventoOuErro: semEvento,
      erros,
      // Isso aqui é só pra conferência: mostra o evento cru que a API dos Correios
      // devolveu, pra confirmar se "dataEvento" pegou o campo certo. Pode remover
      // esse campo do retorno depois de conferir uma vez, se quiser deixar mais limpo.
      amostraUltimoEvento,
      // Idem: resposta crua da 1ª chamada, sem filtro nenhum.
      amostraRespostaCrua,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
