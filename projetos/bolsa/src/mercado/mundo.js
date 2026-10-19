import { numero, pool } from "../banco.js";
import { publicar } from "../hub.js";
import { registrar, registrarErro } from "../log.js";
import { listarAtivos, ranking } from "./consultas.js";
import { executarNaFila } from "./ordens.js";
import { redefinirReferencias } from "./protecao.js";

export const MODELOS = [
  { id: "lucro-acima", grupo: "positivo", titulo: "Lucro trimestral acima do esperado", impactoPct: 8 },
  { id: "contrato", grupo: "positivo", titulo: "Contrato bilionário assinado", impactoPct: 15 },
  { id: "regulador", grupo: "positivo", titulo: "Aprovação regulatória de novo produto", impactoPct: 10 },
  { id: "aquisicao", grupo: "positivo", titulo: "Oferta de aquisição com prêmio", impactoPct: 25 },
  { id: "rating-alta", grupo: "positivo", titulo: "Rating de crédito elevado", impactoPct: 5 },
  { id: "lucro-abaixo", grupo: "negativo", titulo: "Lucro trimestral abaixo do esperado", impactoPct: -8 },
  { id: "escandalo", grupo: "negativo", titulo: "Escândalo contábil vem a público", impactoPct: -30 },
  { id: "greve", grupo: "negativo", titulo: "Greve paralisa a produção", impactoPct: -12 },
  { id: "multa", grupo: "negativo", titulo: "Multa ambiental milionária", impactoPct: -10 },
  { id: "ceo", grupo: "negativo", titulo: "Presidente renuncia de surpresa", impactoPct: -15 },
  { id: "rating-baixa", grupo: "negativo", titulo: "Rating de crédito rebaixado", impactoPct: -5 },
  { id: "juros-corte", grupo: "mercado", titulo: "Banco Central corta os juros", impactoPct: 6 },
  { id: "crise-fiscal", grupo: "mercado", titulo: "Crise fiscal assusta investidores", impactoPct: -10 },
];

export const configMundo = { automaticas: false, intervaloS: 45, meiaVidaS: 120 };

const PESO_CONFIANCA = 0.12;
const CHOQUE_POR_PONTO = 3;
const AMOSTRA_MS = 5000;
const MAX_AMOSTRAS = 120;
const FUNDADOR = "agente-";

const estadoAtivos = new Map();
const amostras = [];
let proximaAutomatica = 0;
let recomecando = false;
let pausadoPorFora = false;

function limitar(valor, minimo, maximo) {
  return Math.min(maximo, Math.max(minimo, valor));
}

function entre(minimo, maximo) {
  return minimo + Math.random() * (maximo - minimo);
}

async function sincronizarAtivos() {
  for (const ativo of await listarAtivos()) {
    const atual = estadoAtivos.get(ativo.ticker) || { confianca: 0, ultimaNoticia: null };
    estadoAtivos.set(ativo.ticker, { ...atual, nome: ativo.nome, fundamento: ativo.fundamentoCentavos });
  }
}

export function mundoPausado() {
  return recomecando || pausadoPorFora;
}

export function pausarMercado(valor) {
  pausadoPorFora = valor;
}

export async function zerarMundo() {
  configMundo.automaticas = false;
  configMundo.intervaloS = 45;
  configMundo.meiaVidaS = 120;
  estadoAtivos.clear();
  amostras.length = 0;
  agendarAutomatica();
  await sincronizarAtivos();
}

export function percepcao(ticker) {
  const ativo = estadoAtivos.get(ticker);
  if (!ativo) return null;
  return {
    fundamentoCentavos: ativo.fundamento,
    confianca: ativo.confianca,
    percebidoCentavos: Math.max(1, Math.round(ativo.fundamento * (1 + (ativo.confianca / 100) * PESO_CONFIANCA))),
  };
}

export function carteiraEquilibrada(capitalCentavos, fracaoEmAcoes, ativos) {
  const porAtivo = (capitalCentavos * fracaoEmAcoes) / ativos.length;
  let investido = 0;
  const posicoes = [];
  for (const ativo of ativos) {
    const quantidade = Math.floor(porAtivo / ativo.precoCentavos);
    if (quantidade <= 0) continue;
    investido += quantidade * ativo.precoCentavos;
    posicoes.push({ ativoId: ativo.id, quantidade, precoCentavos: ativo.precoCentavos });
  }
  return { posicoes, caixaCentavos: capitalCentavos - investido };
}

export async function soltarNoticia({ ticker, titulo, impactoPct, origem, adminId = null }) {
  await sincronizarAtivos();
  const alvos = ticker ? [ticker] : [...estadoAtivos.keys()];
  const fundamentos = {};
  for (const alvo of alvos) {
    const ativo = estadoAtivos.get(alvo);
    if (!ativo) continue;
    const antes = ativo.fundamento;
    const depois = Math.max(1, Math.round(antes * (1 + impactoPct / 100)));
    ativo.fundamento = depois;
    ativo.confianca = limitar(ativo.confianca + impactoPct * CHOQUE_POR_PONTO, -100, 100);
    ativo.ultimaNoticia = { titulo, impactoPct, em: new Date().toISOString() };
    fundamentos[alvo] = { antes, depois, confianca: Math.round(ativo.confianca) };
    await pool.query("UPDATE ativos SET fundamento_centavos = ? WHERE ticker = ?", [depois, alvo]);
  }
  const [insercao] = await pool.query(
    "INSERT INTO noticias (ticker, titulo, impacto_pct, origem, admin_id, fundamentos) VALUES (?, ?, ?, ?, ?, ?)",
    [ticker || null, titulo, impactoPct, origem, adminId, JSON.stringify(fundamentos)]
  );
  registrar("MUNDO_NOTICIA", {
    noticiaId: insercao.insertId,
    ticker: ticker || "mercado",
    titulo,
    impactoPct,
    origem,
    adminId: adminId ?? undefined,
    fundamentos,
  }, impactoPct < 0 ? "aviso" : "info");
  publicar({ tipo: "NOTICIA", em: new Date().toISOString(), ticker: ticker || null, titulo, impactoPct });
  return { id: insercao.insertId, ticker: ticker || null, titulo, impactoPct, fundamentos };
}

function sortear(lista) {
  return lista[Math.floor(Math.random() * lista.length)];
}

async function noticiaAutomatica() {
  const sorteio = Math.random();
  const grupo = sorteio < 0.15 ? "mercado" : sorteio < 0.575 ? "positivo" : "negativo";
  const modelo = sortear(MODELOS.filter((item) => item.grupo === grupo));
  const tickers = [...estadoAtivos.keys()];
  const ticker = modelo.grupo === "mercado" ? null : sortear(tickers);
  const impactoPct = Number((modelo.impactoPct * entre(0.6, 1.3)).toFixed(1));
  await soltarNoticia({ ticker, titulo: modelo.titulo, impactoPct, origem: "automatica" });
}

function agendarAutomatica() {
  proximaAutomatica = Date.now() + configMundo.intervaloS * 1000 * entre(0.6, 1.4);
}

export function configurarMundo({ automaticas, intervaloS, meiaVidaS }) {
  configMundo.automaticas = automaticas;
  configMundo.intervaloS = intervaloS;
  configMundo.meiaVidaS = meiaVidaS;
  agendarAutomatica();
  registrar("MUNDO_CONFIGURADO", { ...configMundo });
  return { ...configMundo };
}

function passarTempo() {
  const fator = 0.5 ** (1 / configMundo.meiaVidaS);
  for (const ativo of estadoAtivos.values()) {
    ativo.confianca = limitar(ativo.confianca * fator + (Math.random() - 0.5) * 1.5, -100, 100);
  }
  if (configMundo.automaticas && !mundoPausado() && Date.now() >= proximaAutomatica) {
    agendarAutomatica();
    noticiaAutomatica().catch((erro) => registrarErro("MUNDO_ERRO", erro));
  }
}

async function estruturaDoMercado() {
  const [linhas] = await pool.query(
    `SELECT
       (SELECT COALESCE(SUM(saldo_centavos), 0) FROM usuarios
         WHERE papel <> 'admin' AND estado = 'ativo' AND (perfil IS NULL OR perfil <> 'sonda')) AS caixa,
       COALESCE(SUM(p.quantidade * a.preco_centavos), 0) AS mercado,
       COALESCE(SUM(p.quantidade * a.preco_abertura_centavos), 0) AS abertura,
       COALESCE(SUM(p.quantidade * a.fundamento_centavos), 0) AS fundamento
     FROM posicoes p JOIN ativos a ON a.id = p.ativo_id`
  );
  const linha = linhas[0];
  const mercado = numero(linha.mercado);
  const abertura = numero(linha.abertura);
  return {
    caixaCentavos: numero(linha.caixa),
    valorEmAcoesCentavos: mercado,
    caixaPorAcoes: mercado ? numero(linha.caixa) / mercado : 0,
    indiceDesdeAberturaPct: abertura ? ((mercado - abertura) / abertura) * 100 : 0,
    premioSobreValorJustoPct: numero(linha.fundamento) ? ((mercado - numero(linha.fundamento)) / numero(linha.fundamento)) * 100 : 0,
  };
}

export async function resultadoDoMercado() {
  const contas = (await ranking()).filter((conta) => conta.perfil !== "sonda");
  const porPerfil = {};
  let ganhos = 0;
  let perdas = 0;
  let capital = 0;
  const emJogo = contas.filter((conta) => conta.estado === "ativo" || conta.estado === "quebrado");
  for (const conta of contas) {
    const grupo = (porPerfil[conta.perfil] ||= { contas: 0, ganhando: 0, perdendo: 0, lucroCentavos: 0, capitalCentavos: 0 });
    grupo.contas += 1;
    grupo.lucroCentavos += conta.lucroCentavos;
    grupo.capitalCentavos += conta.capitalInicialCentavos;
    if (conta.lucroCentavos > 0) grupo.ganhando += 1;
    else if (conta.lucroCentavos < 0) grupo.perdendo += 1;
  }
  for (const conta of emJogo) {
    capital += conta.capitalInicialCentavos;
    if (conta.lucroCentavos > 0) ganhos += conta.lucroCentavos;
    else perdas += conta.lucroCentavos;
  }
  for (const grupo of Object.values(porPerfil)) {
    grupo.retornoPct = grupo.capitalCentavos ? (grupo.lucroCentavos / grupo.capitalCentavos) * 100 : 0;
  }
  const comRetorno = contas.map((conta) => ({
    id: conta.id,
    nome: conta.nome,
    perfil: conta.perfil,
    estado: conta.estado,
    lucroCentavos: conta.lucroCentavos,
    retornoPct: conta.capitalInicialCentavos ? (conta.lucroCentavos / conta.capitalInicialCentavos) * 100 : 0,
  }));
  return {
    contas: emJogo.length,
    ganhando: emJogo.filter((conta) => conta.lucroCentavos > 0).length,
    perdendo: emJogo.filter((conta) => conta.lucroCentavos < 0).length,
    ganhosCentavos: ganhos,
    perdasCentavos: perdas,
    liquidoCentavos: ganhos + perdas,
    retornoMedioPct: capital ? ((ganhos + perdas) / capital) * 100 : 0,
    porPerfil,
    melhores: comRetorno.slice(0, 5),
    piores: comRetorno.slice(-5).reverse(),
    estrutura: await estruturaDoMercado(),
  };
}

async function amostrar() {
  if (mundoPausado()) return;
  try {
    const resultado = await resultadoDoMercado();
    amostras.push({
      em: new Date().toISOString(),
      ganhando: resultado.ganhando,
      perdendo: resultado.perdendo,
      liquidoCentavos: resultado.liquidoCentavos,
      retornoMedioPct: resultado.retornoMedioPct,
      indicePct: resultado.estrutura.indiceDesdeAberturaPct,
    });
    if (amostras.length > MAX_AMOSTRAS) amostras.shift();
  } catch (erro) {
    registrarErro("MUNDO_ERRO", erro);
  }
}

export async function noticiasRecentes(limite = 20) {
  const [linhas] = await pool.query(
    "SELECT id, ticker, titulo, impacto_pct, origem, fundamentos, criada_em FROM noticias ORDER BY id DESC LIMIT ?",
    [limite]
  );
  return linhas.map((linha) => ({
    id: numero(linha.id),
    ticker: linha.ticker,
    titulo: linha.titulo,
    impactoPct: Number(linha.impacto_pct),
    origem: linha.origem,
    fundamentos: typeof linha.fundamentos === "string" ? JSON.parse(linha.fundamentos) : linha.fundamentos,
    em: linha.criada_em,
  }));
}

export async function estadoMundo() {
  await sincronizarAtivos();
  return {
    config: { ...configMundo, proximaAutomatica: configMundo.automaticas ? new Date(proximaAutomatica).toISOString() : null },
    pesoConfiancaPct: PESO_CONFIANCA * 100,
    choquePorPonto: CHOQUE_POR_PONTO,
    ativos: [...estadoAtivos.entries()].map(([ticker, ativo]) => ({
      ticker,
      nome: ativo.nome,
      ...percepcao(ticker),
      ultimaNoticia: ativo.ultimaNoticia,
    })),
    amostras,
  };
}

export async function recomecarRodada(adminId) {
  if (recomecando) return null;
  recomecando = true;
  try {
    const resumo = await executarNaFila(async (conexao) => {
      await conexao.query(
        `UPDATE usuarios u JOIN (
           SELECT usuario_id, SUM(preco_centavos * quantidade_restante) AS valor FROM ordens
           WHERE lado = 'compra' AND status IN ('aberta', 'parcial') GROUP BY usuario_id
         ) r ON r.usuario_id = u.id
         SET u.saldo_centavos = u.saldo_centavos + r.valor`
      );
      await conexao.query(
        `UPDATE posicoes p JOIN (
           SELECT usuario_id, ativo_id, SUM(quantidade_restante) AS qtd FROM ordens
           WHERE lado = 'venda' AND status IN ('aberta', 'parcial') GROUP BY usuario_id, ativo_id
         ) r ON r.usuario_id = p.usuario_id AND r.ativo_id = p.ativo_id
         SET p.quantidade_reservada = p.quantidade_reservada - r.qtd`
      );
      const [canceladas] = await conexao.query(
        "UPDATE ordens SET quantidade_restante = 0, status = 'cancelada' WHERE status IN ('aberta', 'parcial')"
      );
      await conexao.query("UPDATE ativos SET preco_centavos = fundamento_centavos, preco_abertura_centavos = fundamento_centavos");
      const [ativos] = await conexao.query("SELECT id, ticker, preco_centavos FROM ativos ORDER BY ticker");
      const precos = ativos.map((ativo) => ({ id: numero(ativo.id), ticker: ativo.ticker, precoCentavos: numero(ativo.preco_centavos) }));

      const [baleias] = await conexao.query("SELECT id FROM usuarios WHERE perfil = 'baleia' AND estado = 'ativo'");
      if (baleias.length) {
        const ids = baleias.map((baleia) => baleia.id);
        await conexao.query("DELETE FROM posicoes WHERE usuario_id IN (?)", [ids]);
        await conexao.query("UPDATE usuarios SET estado = 'encerrado', saldo_centavos = 0, divida_centavos = 0 WHERE id IN (?)", [ids]);
      }

      const [contas] = await conexao.query(
        `SELECT id, email, estado, capital_inicial_centavos FROM usuarios
         WHERE (agente = 1 AND (perfil IS NULL OR perfil <> 'baleia')) OR perfil = 'carga'`
      );
      if (contas.length) {
        await conexao.query("DELETE FROM posicoes WHERE usuario_id IN (?)", [contas.map((conta) => conta.id)]);
      }
      const linhas = [];
      for (const conta of contas) {
        const fracao = conta.email.startsWith(FUNDADOR) ? 0.5 : entre(0.3, 0.7);
        const carteira = carteiraEquilibrada(numero(conta.capital_inicial_centavos), fracao, precos);
        for (const posicao of carteira.posicoes) {
          linhas.push([conta.id, posicao.ativoId, posicao.quantidade, 0, posicao.precoCentavos]);
        }
        await conexao.query(
          `UPDATE usuarios SET saldo_centavos = ?, divida_centavos = 0, sacado_centavos = 0,
             estado = IF(estado = 'quebrado', 'ativo', estado) WHERE id = ?`,
          [carteira.caixaCentavos, conta.id]
        );
      }
      if (linhas.length) {
        await conexao.query(
          "INSERT INTO posicoes (usuario_id, ativo_id, quantidade, quantidade_reservada, preco_medio_centavos) VALUES ?",
          [linhas]
        );
      }
      return {
        ordensCanceladas: canceladas.affectedRows,
        baleiasRecolhidas: baleias.length,
        contasReequilibradas: contas.length,
        precos: Object.fromEntries(precos.map((ativo) => [ativo.ticker, ativo.precoCentavos])),
      };
    });
    redefinirReferencias(resumo.precos, "rodada recomeçada no valor justo");
    for (const ativo of estadoAtivos.values()) {
      ativo.confianca = 0;
      ativo.ultimaNoticia = null;
    }
    amostras.length = 0;
    registrar("MUNDO_RODADA_RECOMECADA", { adminId, ...resumo });
    publicar({ tipo: "RODADA_RECOMECADA", em: new Date().toISOString() });
    publicar({ tipo: "MERCADO_ATUALIZADO", em: new Date().toISOString(), origem: "mundo" });
    return resumo;
  } finally {
    recomecando = false;
    await sincronizarAtivos();
  }
}

export async function iniciarMundo() {
  await sincronizarAtivos();
  agendarAutomatica();
  setInterval(passarTempo, 1000).unref();
  setInterval(amostrar, AMOSTRA_MS).unref();
  registrar("MUNDO_INICIADO", { ...configMundo, pesoConfiancaPct: PESO_CONFIANCA * 100 });
}
