import bcrypt from "bcryptjs";
import { numero, pool } from "../banco.js";
import { publicar } from "../hub.js";
import { registrar, registrarErro } from "../log.js";
import {
  contextoDoAtivo,
  listarAtivos,
  livresDoUsuario,
  ordensAbertasDe,
  participacao,
  resultadoDosOutros,
  visaoSemProprias,
} from "./consultas.js";
import { mundoPausado } from "./mundo.js";
import { cancelarOrdem, enviarOrdem, executarNaFila } from "./ordens.js";

const FORA_DO_CAOS = "email NOT LIKE 'agente-%' AND (perfil IS NULL OR perfil <> 'baleia')";

export const configCaos = {
  alavancagem: 1,
  roleta: { ativa: false, chanceGanho: 0.04, chanceQuebra: 0.03 },
  margemMinimaPct: 10,
};

const TICK_BALEIA_MS = 1500;
const MAX_TICKS_INFLANDO = 40;
const MAX_TICKS_DESPEJANDO = 25;

let senhaRobos = null;
let baleiasOcupadas = false;

function entre(minimo, maximo) {
  return minimo + Math.random() * (maximo - minimo);
}

export async function hashRobo() {
  senhaRobos ||= await bcrypt.hash(`robo-${Date.now()}-${Math.random()}`, 8);
  return senhaRobos;
}

function avisarMercado() {
  publicar({ tipo: "MERCADO_ATUALIZADO", em: new Date().toISOString(), origem: "caos" });
}

async function patrimonioDe(usuarioId) {
  const [linhas] = await pool.query(
    `SELECT u.saldo_centavos, u.divida_centavos,
            COALESCE((SELECT SUM(p.quantidade * a.preco_centavos) FROM posicoes p
                      JOIN ativos a ON a.id = p.ativo_id WHERE p.usuario_id = u.id), 0) AS mercado,
            COALESCE((SELECT SUM(o.preco_centavos * o.quantidade_restante) FROM ordens o
                      WHERE o.usuario_id = u.id AND o.lado = 'compra' AND o.status IN ('aberta', 'parcial')), 0) AS reservado
     FROM usuarios u WHERE u.id = ?`,
    [usuarioId]
  );
  if (linhas.length === 0) return null;
  const linha = linhas[0];
  const saldo = numero(linha.saldo_centavos);
  const patrimonio = saldo + numero(linha.reservado) + numero(linha.mercado);
  return { saldo, divida: numero(linha.divida_centavos), patrimonio, liquido: patrimonio - numero(linha.divida_centavos) };
}

async function cancelarTudo(usuarioId, ticker) {
  for (const ordemId of await ordensAbertasDe(usuarioId, ticker)) {
    try {
      await cancelarOrdem(usuarioId, ordemId);
    } catch {
      // a ordem pode ter sido executada entre a consulta e o cancelamento
    }
  }
}

async function despejarPosicoes(usuarioId, descontoPct, origem) {
  await cancelarTudo(usuarioId);
  const { livres } = await livresDoUsuario(usuarioId);
  const ativos = await listarAtivos();
  let enviadas = 0;
  for (const ativo of ativos) {
    const quantidade = Math.min(livres[ativo.ticker] || 0, 100000);
    if (quantidade <= 0) continue;
    const precoCentavos = Math.max(1, Math.round(ativo.precoCentavos * (1 - descontoPct / 100)));
    try {
      await enviarOrdem({ usuarioId, ticker: ativo.ticker, lado: "venda", quantidade, precoCentavos, origem });
      enviadas += 1;
    } catch {
      // breaker ou falha injetada: as ações seguem na carteira
    }
  }
  return enviadas;
}

async function alterarSaldo(usuarioId, deltaCentavos, motivo, extra = {}) {
  return executarNaFila(async (conexao) => {
    const [linhas] = await conexao.query(
      "SELECT nome, saldo_centavos FROM usuarios WHERE id = ? AND agente = 1 FOR UPDATE",
      [usuarioId]
    );
    if (linhas.length === 0) throw new Error("Só agentes podem sofrer efeitos do caos.");
    const saldo = numero(linhas[0].saldo_centavos);
    const aplicado = Math.max(-saldo, deltaCentavos);
    await conexao.query("UPDATE usuarios SET saldo_centavos = saldo_centavos + ? WHERE id = ?", [aplicado, usuarioId]);
    registrar(motivo, { usuarioId, agente: linhas[0].nome, deltaCentavos: aplicado, saldoAnterior: saldo, ...extra });
    return aplicado;
  });
}

export async function ganhoExtraordinario(usuarioId, origem = "roleta") {
  const estado = await patrimonioDe(usuarioId);
  if (!estado) return null;
  const premio = Math.round(estado.patrimonio * entre(0.3, 1.5) * configCaos.alavancagem);
  return alterarSaldo(usuarioId, premio, "CAOS_GANHO", { origem, alavancagem: configCaos.alavancagem });
}

export async function quebrarAgente(usuarioId, origem = "roleta") {
  const estado = await patrimonioDe(usuarioId);
  if (!estado) return null;
  await pool.query("UPDATE usuarios SET estado = 'quebrado' WHERE id = ? AND agente = 1", [usuarioId]);
  await alterarSaldo(usuarioId, -estado.saldo, "CAOS_QUEBRA", {
    origem,
    patrimonioAntesCentavos: estado.patrimonio,
    dividaCentavos: estado.divida,
  });
  const ordens = await despejarPosicoes(usuarioId, 8, "caos");
  registrar("AGENTE_QUEBROU", { usuarioId, origem, ordensDeLiquidacao: ordens });
  avisarMercado();
  return true;
}

export async function aplicarAlavancagem(fator) {
  configCaos.alavancagem = fator;
  const [agentes] = await pool.query(
    `SELECT id FROM usuarios WHERE agente = 1 AND estado = 'ativo' AND ${FORA_DO_CAOS}`
  );
  let tomado = 0;
  let pago = 0;
  for (const { id } of agentes) {
    const estado = await patrimonioDe(id);
    if (!estado) continue;
    const alvoDivida = Math.max(0, Math.round(estado.liquido * (fator - 1)));
    const delta = alvoDivida - estado.divida;
    await executarNaFila(async (conexao) => {
      const [linhas] = await conexao.query("SELECT saldo_centavos, divida_centavos FROM usuarios WHERE id = ? FOR UPDATE", [id]);
      const saldo = numero(linhas[0].saldo_centavos);
      if (delta > 0) {
        await conexao.query(
          "UPDATE usuarios SET saldo_centavos = saldo_centavos + ?, divida_centavos = divida_centavos + ? WHERE id = ?",
          [delta, delta, id]
        );
        tomado += delta;
      } else if (delta < 0) {
        const quitacao = Math.min(saldo, -delta, numero(linhas[0].divida_centavos));
        await conexao.query(
          "UPDATE usuarios SET saldo_centavos = saldo_centavos - ?, divida_centavos = divida_centavos - ? WHERE id = ?",
          [quitacao, quitacao, id]
        );
        pago += quitacao;
      }
    });
  }
  registrar("CAOS_ALAVANCAGEM", { fator, agentes: agentes.length, emprestadoCentavos: tomado, quitadoCentavos: pago });
  return { fator, agentes: agentes.length, emprestadoCentavos: tomado, quitadoCentavos: pago };
}

async function chamadaDeMargem() {
  const [devedores] = await pool.query(
    `SELECT id, nome FROM usuarios WHERE agente = 1 AND estado = 'ativo' AND divida_centavos > 0 AND ${FORA_DO_CAOS}`
  );
  for (const devedor of devedores) {
    const estado = await patrimonioDe(devedor.id);
    if (!estado || estado.patrimonio <= 0) continue;
    const margemPct = (estado.liquido / estado.patrimonio) * 100;
    if (margemPct >= configCaos.margemMinimaPct) continue;
    registrar("MARGEM_CHAMADA", {
      usuarioId: devedor.id,
      agente: devedor.nome,
      margemPct: Number(margemPct.toFixed(1)),
      dividaCentavos: estado.divida,
    });
    await despejarPosicoes(devedor.id, 6, "caos");
    await executarNaFila(async (conexao) => {
      const [linhas] = await conexao.query("SELECT saldo_centavos, divida_centavos FROM usuarios WHERE id = ? FOR UPDATE", [devedor.id]);
      const saldo = numero(linhas[0].saldo_centavos);
      const divida = numero(linhas[0].divida_centavos);
      const quitacao = Math.min(saldo, divida);
      const insolvente = divida - quitacao > 0;
      await conexao.query(
        `UPDATE usuarios SET saldo_centavos = saldo_centavos - ?, divida_centavos = divida_centavos - ?,
           estado = IF(?, 'quebrado', estado) WHERE id = ?`,
        [quitacao, quitacao, insolvente, devedor.id]
      );
      if (insolvente) {
        registrar("AGENTE_QUEBROU", { usuarioId: devedor.id, agente: devedor.nome, origem: "chamada de margem", dividaRestanteCentavos: divida - quitacao });
      }
    });
  }
}

export async function rodarRoleta(agentesDaRodada) {
  if (configCaos.alavancagem > 1) await chamadaDeMargem();
  if (!configCaos.roleta.ativa) return;
  for (const agente of agentesDaRodada) {
    if (agente.email.startsWith("agente-")) continue;
    const sorteio = Math.random();
    const chanceQuebra = Math.min(0.5, configCaos.roleta.chanceQuebra * configCaos.alavancagem);
    if (sorteio < chanceQuebra) {
      await quebrarAgente(agente.id);
    } else if (sorteio < chanceQuebra + configCaos.roleta.chanceGanho) {
      await ganhoExtraordinario(agente.id);
    }
  }
}

export async function reanimarQuebrados() {
  return executarNaFila(async (conexao) => {
    const [resultado] = await conexao.query(
      `UPDATE usuarios
       SET estado = 'ativo', saldo_centavos = saldo_centavos + capital_inicial_centavos, divida_centavos = 0
       WHERE agente = 1 AND estado = 'quebrado' AND (perfil IS NULL OR perfil <> 'baleia')`
    );
    registrar("CAOS_AGENTES_REANIMADOS", { quantidade: resultado.affectedRows, aporte: "capital inicial de cada um" });
    return resultado.affectedRows;
  });
}

export async function criarBaleia({ ticker, capitalCentavos, alavancagem, alvoParticipacaoPct, alvoLucroPct }) {
  const [quantas] = await pool.query("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'baleia'");
  const numeroBaleia = numero(quantas[0].n) + 1;
  const capitalTotal = Math.round(capitalCentavos * alavancagem);
  const divida = capitalTotal - capitalCentavos;
  const contexto = await contextoDoAtivo(ticker);
  const plano = {
    ticker,
    fase: "acumulando",
    alavancagem,
    alvoParticipacaoPct,
    alvoLucroPct,
    precoEntradaCentavos: contexto.ultimo,
    precoPicoCentavos: contexto.ultimo,
    precoSaidaCentavos: null,
    participacaoMaxPct: 0,
    ticksNaFase: 0,
    iniciadaEm: new Date().toISOString(),
  };
  const [insercao] = await pool.query(
    `INSERT INTO usuarios (nome, email, senha_hash, saldo_centavos, capital_inicial_centavos, agente, perfil, divida_centavos, plano)
     VALUES (?, ?, ?, ?, ?, 1, 'baleia', ?, ?)`,
    [
      `Baleia #${numeroBaleia} (${ticker})`,
      `baleia-${Date.now()}@bolsa.local`,
      await hashRobo(),
      capitalTotal,
      capitalCentavos,
      divida,
      JSON.stringify(plano),
    ]
  );
  registrar("BALEIA_SOLTA", {
    usuarioId: insercao.insertId,
    ticker,
    capitalCentavos,
    alavancagem,
    capitalOperacionalCentavos: capitalTotal,
    alvoParticipacaoPct,
    alvoLucroPct,
  });
  return insercao.insertId;
}

async function salvarPlano(id, plano, extra = "") {
  await pool.query(`UPDATE usuarios SET plano = ? ${extra} WHERE id = ?`, [JSON.stringify(plano), id]);
}

function mudarFase(baleia, plano, fase, dados = {}) {
  registrar(`BALEIA_${fase.toUpperCase()}`, { usuarioId: baleia.id, baleia: baleia.nome, ticker: plano.ticker, faseAnterior: plano.fase, ...dados });
  plano.fase = fase;
  plano.ticksNaFase = 0;
}

async function ordemBaleia(baleia, plano, lado, quantidade, precoCentavos) {
  if (quantidade < 1) return false;
  try {
    await enviarOrdem({ usuarioId: baleia.id, ticker: plano.ticker, lado, quantidade, precoCentavos, origem: "baleia" });
    return true;
  } catch {
    return false;
  }
}

async function sacar(baleia, plano) {
  await cancelarTudo(baleia.id);
  const resultado = await executarNaFila(async (conexao) => {
    const [linhas] = await conexao.query(
      "SELECT saldo_centavos, divida_centavos, capital_inicial_centavos FROM usuarios WHERE id = ? FOR UPDATE",
      [baleia.id]
    );
    const saldo = numero(linhas[0].saldo_centavos);
    const divida = numero(linhas[0].divida_centavos);
    const saque = Math.max(0, saldo - divida);
    await conexao.query(
      "UPDATE usuarios SET saldo_centavos = 0, divida_centavos = GREATEST(0, divida_centavos - ?), sacado_centavos = ?, estado = ? WHERE id = ?",
      [saldo, saque, saque > 0 ? "saiu" : "quebrado", baleia.id]
    );
    return { saque, lucroCentavos: saque - numero(linhas[0].capital_inicial_centavos) };
  });
  const outros = await resultadoDosOutros(plano.ticker, baleia.id);
  const contexto = await contextoDoAtivo(plano.ticker);
  plano.precoSaidaCentavos = contexto.ultimo;
  plano.resultadoOutrosCentavos = outros.resultadoCentavos;
  plano.lucroCentavos = resultado.lucroCentavos;
  mudarFase(baleia, plano, "saiu", {
    sacadoCentavos: resultado.saque,
    lucroCentavos: resultado.lucroCentavos,
    precoEntradaCentavos: plano.precoEntradaCentavos,
    precoPicoCentavos: plano.precoPicoCentavos,
    precoSaidaCentavos: contexto.ultimo,
    detentoresPrejudicados: outros.detentores,
    resultadoDosOutrosCentavos: outros.resultadoCentavos,
  });
  await salvarPlano(baleia.id, plano);
  avisarMercado();
}

async function turnoBaleia(baleia) {
  const plano = typeof baleia.plano === "string" ? JSON.parse(baleia.plano) : baleia.plano;
  const contexto = await contextoDoAtivo(plano.ticker);
  const visao = visaoSemProprias(contexto, baleia.id);
  const { livres, totais } = await livresDoUsuario(baleia.id);
  const fatia = await participacao(plano.ticker, baleia.id);
  const estado = await patrimonioDe(baleia.id);
  const capital = numero(baleia.capital_inicial_centavos);
  const [medio] = await pool.query(
    "SELECT p.preco_medio_centavos FROM posicoes p WHERE p.usuario_id = ? AND p.ativo_id = ?",
    [baleia.id, contexto.ativoId]
  );
  const precoMedio = medio.length ? numero(medio[0].preco_medio_centavos) : contexto.ultimo;
  const lucroPct = ((contexto.ultimo - precoMedio) / precoMedio) * 100;
  plano.precoMedioCentavos = precoMedio;
  plano.resultadoCentavos = estado.liquido - capital;
  plano.ticksNaFase += 1;
  plano.participacaoPct = Number(fatia.pct.toFixed(1));
  plano.participacaoMaxPct = Math.max(plano.participacaoMaxPct, plano.participacaoPct);
  plano.precoPicoCentavos = Math.max(plano.precoPicoCentavos, contexto.ultimo);
  plano.lucroPct = Number(lucroPct.toFixed(1));
  plano.acoes = totais[plano.ticker] || 0;

  if (plano.fase === "acumulando") {
    await cancelarTudo(baleia.id, plano.ticker);
    const preco = Math.round((visao.melhorVenda ?? contexto.ultimo) * 1.01);
    const lote = Math.min(Math.floor(estado.saldo / preco), Math.max(50, Math.floor(fatia.total * 0.08)), 5000);
    await ordemBaleia(baleia, plano, "compra", lote, preco);
    if (fatia.pct >= plano.alvoParticipacaoPct || estado.saldo < preco * 10 || plano.ticksNaFase > 60) {
      mudarFase(baleia, plano, "inflando", { participacaoPct: plano.participacaoPct });
    }
  } else if (plano.fase === "inflando") {
    await cancelarTudo(baleia.id, plano.ticker);
    const topo = Math.round(contexto.ultimo * 1.04);
    const vendaPequena = Math.min(livres[plano.ticker] || 0, Math.max(1, Math.floor((totais[plano.ticker] || 0) * 0.005)));
    await ordemBaleia(baleia, plano, "compra", Math.min(Math.floor(estado.saldo / topo), 40), topo);
    await ordemBaleia(baleia, plano, "venda", vendaPequena, Math.round(contexto.ultimo * 1.06));
    if (lucroPct >= plano.alvoLucroPct || plano.ticksNaFase > MAX_TICKS_INFLANDO) {
      mudarFase(baleia, plano, "despejando", {
        lucroPct: plano.lucroPct,
        motivo: lucroPct >= plano.alvoLucroPct ? "meta de lucro atingida" : "meta não veio; desiste e sai",
      });
    }
  } else if (plano.fase === "despejando") {
    await cancelarTudo(baleia.id, plano.ticker);
    const desconto = 0.85 - plano.ticksNaFase * 0.03;
    const preco = Math.max(1, Math.round((visao.melhorCompra ?? contexto.ultimo) * Math.max(0.4, desconto)));
    const lote = Math.max(1, Math.ceil((livres[plano.ticker] || 0) * 0.5));
    await ordemBaleia(baleia, plano, "venda", Math.min(lote, livres[plano.ticker] || 0), preco);
    if ((totais[plano.ticker] || 0) === 0 || plano.ticksNaFase > MAX_TICKS_DESPEJANDO) {
      await sacar(baleia, plano);
      return;
    }
  }
  await salvarPlano(baleia.id, plano);
}

export function caosOcupado() {
  return baleiasOcupadas;
}

export function zerarCaos() {
  configCaos.alavancagem = 1;
  configCaos.roleta = { ativa: false, chanceGanho: 0.04, chanceQuebra: 0.03 };
}

async function cicloBaleias() {
  if (baleiasOcupadas || mundoPausado()) return;
  baleiasOcupadas = true;
  try {
    const [baleias] = await pool.query(
      "SELECT id, nome, capital_inicial_centavos, plano FROM usuarios WHERE perfil = 'baleia' AND estado = 'ativo'"
    );
    for (const baleia of baleias) {
      try {
        await turnoBaleia(baleia);
      } catch (erro) {
        registrarErro("BALEIA_ERRO", erro, { usuarioId: baleia.id });
      }
    }
  } finally {
    baleiasOcupadas = false;
  }
}

export function iniciarCaos() {
  setInterval(cicloBaleias, TICK_BALEIA_MS).unref();
}

export async function estadoBaleias() {
  const [baleias] = await pool.query(
    `SELECT id, nome, estado, saldo_centavos, divida_centavos, sacado_centavos, capital_inicial_centavos, plano
     FROM usuarios WHERE perfil = 'baleia' ORDER BY id DESC LIMIT 12`
  );
  return Promise.all(baleias.map(async (baleia) => {
    const plano = typeof baleia.plano === "string" ? JSON.parse(baleia.plano) : baleia.plano || {};
    const outros = plano.ticker ? await resultadoDosOutros(plano.ticker, baleia.id) : null;
    return {
      id: numero(baleia.id),
      nome: baleia.nome,
      estado: baleia.estado,
      saldoCentavos: numero(baleia.saldo_centavos),
      dividaCentavos: numero(baleia.divida_centavos),
      sacadoCentavos: numero(baleia.sacado_centavos),
      capitalCentavos: numero(baleia.capital_inicial_centavos),
      plano,
      resultadoDosOutrosCentavos: outros?.resultadoCentavos ?? 0,
      acoesDosOutros: outros?.acoes ?? 0,
      detentores: outros?.detentores ?? 0,
    };
  }));
}

export async function encerrarBaleia(id) {
  const [linhas] = await pool.query(
    "SELECT id, nome, capital_inicial_centavos, plano FROM usuarios WHERE id = ? AND perfil = 'baleia' AND estado = 'ativo'",
    [id]
  );
  if (linhas.length === 0) return false;
  const baleia = linhas[0];
  const plano = typeof baleia.plano === "string" ? JSON.parse(baleia.plano) : baleia.plano;
  if (plano.fase !== "despejando") mudarFase(baleia, plano, "despejando", { motivo: "ordem do ADMIN" });
  await salvarPlano(baleia.id, plano);
  return true;
}
