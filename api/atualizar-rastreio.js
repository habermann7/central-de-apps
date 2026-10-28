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
function norm(t){ return String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim(); }
function ehEntregue(status){
  const n = norm(status);
  return STATUS_ENTREGUE.some((e) => norm(e) === n) || n.startsWith('objeto entregue');
}

const STATUS_MORTOS = [
  'Etiqueta Expirada',
  'Erro Geraçâo PPN',
];

// Se um código falhar (ex: "não localizado") essa quantidade de vezes seguidas,
// para de tentar esse código — provavelmente é lixo (etiqueta nunca postada,
// código digitado errado etc), não vale continuar gastando consulta com ele.
const LIMITE_TENTATIVAS_SEM_SUCESSO = 5;
// Depois de travar nas tentativas, dá mais uma chance a cada 3 dias (os Correios
// às vezes demoram a "enxergar" um objeto recém-postado).
const REPESCAGEM_MS = 3 * 24 * 60 * 60 * 1000;

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

async function consultarUmCodigo(codigo, tentativa = 1) {
  const url =
    'https://api.correios.com.br/srorastro/v1/objetos/' +
    encodeURIComponent(codigo) +
    '?resultado=U&idioma=pt-BR';

  let resposta;
  try {
    resposta = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + process.env.CORREIOS_CHAVE_ACESSO,
        'Accept-Language': 'pt-BR',
      },
    });
  } catch (e) {
    // erro de rede: tenta mais 1 vez; se persistir, é temporário (não conta como falha do código)
    if (tentativa < 2) return consultarUmCodigo(codigo, tentativa + 1);
    return { codigo, ok: false, temporario: true, erro: 'rede: ' + e.message };
  }

  if (!resposta.ok) {
    // 429 (muita consulta) e 5xx (Correios fora) são temporários: espera um pouco e tenta de novo
    if ((resposta.status === 429 || resposta.status >= 500) && tentativa < 3) {
      await new Promise((r) => setTimeout(r, 800 * tentativa));
      return consultarUmCodigo(codigo, tentativa + 1);
    }
    const textoErro = await resposta.text().catch(() => '');
    const temporario = resposta.status === 429 || resposta.status >= 500 || resposta.status === 401 || resposta.status === 403;
    return {
      codigo, ok: false, temporario,
      erro: 'HTTP ' + resposta.status + (textoErro ? ' — ' + textoErro.slice(0, 200) : ''),
    };
  }

  let dados;
  try { dados = await resposta.json(); } catch (e) {
    return { codigo, ok: false, temporario: true, erro: 'resposta inválida' };
  }
  const objetos = dados.objetos || dados.objeto || [];
  const objeto = objetos[0];
  if (!objeto) return { codigo, ok: false, erro: 'resposta sem objeto', dadosCrus: dados };

  const eventos = objeto.eventos || objeto.evento || [];
  if (eventos.length === 0) {
    return { codigo, ok: false, erro: objeto.mensagem || 'sem eventos', dadosCrus: dados };
  }

  // O evento mais recente é o de maior data (não confia só na posição na lista)
  let maisRecente = eventos[0];
  let melhor = Date.parse(extrairDataEvento(maisRecente) || '') || 0;
  for (const ev of eventos) {
    const t = Date.parse(extrairDataEvento(ev) || '') || 0;
    if (t > melhor) { melhor = t; maisRecente = ev; }
  }

  return { codigo, ok: true, evento: maisRecente, dtPrevista: objeto.dtPrevista || null, dadosCrus: dados };
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
      if (!p || typeof p !== 'object') return false;
      if (ehEntregue(p.status)) return false;
      if (STATUS_MORTOS.includes(p.status)) return false;
      const ns = norm(p.status);
      if (ns.startsWith('etiqueta expirada') || ns.startsWith('etiqueta cancelada') || ns.includes('liberado(s) para download')) return false;
      if ((p.tentativasSemSucesso || 0) >= LIMITE_TENTATIVAS_SEM_SUCESSO) {
        // travado: só reconsulta se já passou o prazo da repescagem
        if (Date.now() - (p.ultimaTentativaEm || 0) < REPESCAGEM_MS) return false;
      }
      return true;
    });

    // Ordena por quem foi verificado há mais tempo (ou nunca foi verificado) primeiro.
    // Sem isso, quando sobra mais pendente do que cabe numa execução, sempre os
    // mesmos primeiros da lista são escolhidos de novo — muita coisa em trânsito
    // não muda de status de uma consulta pra outra, então o resto nunca era
    // alcançado. Assim, cada execução sempre avança pros próximos.
    const ultima = (k) => Math.max(todos[k].atualizadoEm || 0, todos[k].ultimaTentativaEm || 0);
    pendentes.sort((a, b) => ultima(a) - ultima(b));

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
        rodada.map((chave) => consultarUmCodigo(codigoPorChave[chave]).catch((e) => ({ codigo: codigoPorChave[chave], ok: false, temporario: true, erro: e.message })).then((r) => ({ chave, ...r })))
      );

      const updates = {};
      for (const r of resultados) {
        if (!amostraRespostaCrua && r.dadosCrus) amostraRespostaCrua = r.dadosCrus;
        if (!r.ok) {
          if (r.erro) semEvento++;
          if (erros.length < 15 && r.erro) erros.push(r.codigo + ': ' + r.erro);
          // erro temporário (Correios fora, limite de consultas, rede) NÃO pune o código
          if (r.temporario) continue;
          const tentativasAtuais = (todos[r.chave] && todos[r.chave].tentativasSemSucesso) || 0;
          updates[CAMINHO_PEDIDOS + '/' + r.chave + '/tentativasSemSucesso'] = tentativasAtuais + 1;
          updates[CAMINHO_PEDIDOS + '/' + r.chave + '/ultimaTentativaEm'] = Date.now();
          continue;
        }
        if (!amostraUltimoEvento) amostraUltimoEvento = r.evento;
        updates[CAMINHO_PEDIDOS + '/' + r.chave + '/status'] = String(r.evento.descricao || r.evento.msg || '').trim();
        if (r.evento.codigo) updates[CAMINHO_PEDIDOS + '/' + r.chave + '/codigoEvento'] = r.evento.codigo + (r.evento.tipo ? '-' + r.evento.tipo : '');
        const dataEvento = extrairDataEvento(r.evento);
        if (dataEvento) {
          updates[CAMINHO_PEDIDOS + '/' + r.chave + '/dataEvento'] = dataEvento;
        }
        if (r.dtPrevista) {
          updates[CAMINHO_PEDIDOS + '/' + r.chave + '/dataPrevista'] = r.dtPrevista;
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
