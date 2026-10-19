import { ErroNegocio, ErroServico } from "../erros.js";
import { publicar } from "../hub.js";
import { registrar } from "../log.js";

export const configMercado = { automatico: true, limitePct: 15, duracaoS: 30 };

const suspensos = new Map();
const referencias = new Map();
const ultimosPrecos = new Map();
let mercado = { ate: 0, motivo: "" };

export const servico = {
  estado: "fechado",
  falhas: 0,
  limiteFalhas: 3,
  esperaS: 10,
  abertoAte: 0,
  falhaInjetadaAte: 0,
};

function hora(instante) {
  return new Date(instante).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function avisarClientes() {
  publicar({ tipo: "BREAKER", em: new Date().toISOString() });
}

function liberarVencidos() {
  const agora = Date.now();
  for (const [ticker, suspensao] of suspensos) {
    if (suspensao.ate <= agora) liberarAtivo(ticker, "prazo encerrado");
  }
  if (mercado.ate && mercado.ate <= agora) {
    mercado = { ate: 0, motivo: "" };
    registrar("BREAKER_MERCADO_LIBERADO", { escopo: "mercado", motivo: "prazo encerrado" });
    avisarClientes();
  }
}

setInterval(liberarVencidos, 1000).unref();

export function verificarNegociacao(ticker) {
  const agora = Date.now();
  if (mercado.ate > agora) {
    throw new ErroNegocio(`Circuit breaker do mercado ativo até ${hora(mercado.ate)}. Novas ordens voltam depois disso.`, "breaker");
  }
  const suspensao = suspensos.get(ticker);
  if (suspensao && suspensao.ate > agora) {
    throw new ErroNegocio(`Circuit breaker em ${ticker} até ${hora(suspensao.ate)}: ${suspensao.motivo}.`, "breaker");
  }
}

export function avaliarPreco(ticker, precoCentavos) {
  ultimosPrecos.set(ticker, precoCentavos);
  if (!referencias.has(ticker)) {
    referencias.set(ticker, precoCentavos);
    return;
  }
  if (!configMercado.automatico || suspensos.has(ticker)) return;
  const referencia = referencias.get(ticker);
  const variacao = ((precoCentavos - referencia) / referencia) * 100;
  if (Math.abs(variacao) >= configMercado.limitePct) {
    suspenderAtivo(
      ticker,
      configMercado.duracaoS,
      `variação de ${variacao.toFixed(1).replace(".", ",")}% desde a referência`,
      "automatico"
    );
  }
}

export function suspenderAtivo(ticker, duracaoS, motivo, origem) {
  const ate = Date.now() + duracaoS * 1000;
  suspensos.set(ticker, { ate, motivo, origem });
  registrar("BREAKER_MERCADO_ACIONADO", { ticker, duracaoS, motivo, origem, referenciaCentavos: referencias.get(ticker) });
  avisarClientes();
}

export function liberarAtivo(ticker, motivo = "liberado pelo ADMIN") {
  if (!suspensos.has(ticker)) return;
  suspensos.delete(ticker);
  if (ultimosPrecos.has(ticker)) referencias.set(ticker, ultimosPrecos.get(ticker));
  registrar("BREAKER_MERCADO_LIBERADO", { ticker, motivo, novaReferenciaCentavos: referencias.get(ticker) });
  avisarClientes();
}

export function suspenderMercado(duracaoS, motivo, origem) {
  mercado = { ate: Date.now() + duracaoS * 1000, motivo };
  registrar("BREAKER_MERCADO_ACIONADO", { escopo: "mercado", duracaoS, motivo, origem });
  avisarClientes();
}

export function liberarMercado() {
  if (mercado.ate) {
    mercado = { ate: 0, motivo: "" };
    registrar("BREAKER_MERCADO_LIBERADO", { escopo: "mercado", motivo: "liberado pelo ADMIN" });
  }
  for (const ticker of [...suspensos.keys()]) liberarAtivo(ticker);
  avisarClientes();
}

export function redefinirReferencias(precos, motivo) {
  suspensos.clear();
  mercado = { ate: 0, motivo: "" };
  for (const [ticker, preco] of Object.entries(precos)) {
    referencias.set(ticker, preco);
    ultimosPrecos.set(ticker, preco);
  }
  registrar("BREAKER_MERCADO_LIBERADO", { escopo: "mercado", motivo, referencias: precos });
  avisarClientes();
}

export function suspensaoDe(ticker) {
  const agora = Date.now();
  if (mercado.ate > agora) return { ate: new Date(mercado.ate).toISOString(), motivo: mercado.motivo || "mercado inteiro" };
  const suspensao = suspensos.get(ticker);
  if (suspensao && suspensao.ate > agora) {
    return { ate: new Date(suspensao.ate).toISOString(), motivo: suspensao.motivo };
  }
  return null;
}

export function rejeitarSeAberto() {
  if (servico.estado === "aberto" && Date.now() < servico.abertoAte) {
    const segundos = Math.ceil((servico.abertoAte - Date.now()) / 1000);
    throw new ErroServico(`Motor de ordens em proteção (circuit breaker aberto). Tente de novo em ${segundos}s.`);
  }
}

export function antesDeExecutar() {
  rejeitarSeAberto();
  if (servico.estado === "aberto") {
    servico.estado = "meio-aberto";
    registrar("BREAKER_SERVICO_MEIO_ABERTO", { motivo: "fim da espera; a próxima ordem testa o banco" });
  }
}

export function aposSucesso() {
  if (servico.estado !== "fechado") {
    registrar("BREAKER_SERVICO_FECHADO", { motivo: "ordem de teste passou", falhasAnteriores: servico.falhas });
  }
  servico.estado = "fechado";
  servico.falhas = 0;
}

export function aposFalha(erro) {
  servico.falhas += 1;
  registrar("FALHA_INFRA", { mensagem: erro.message, falhas: servico.falhas, estado: servico.estado });
  if (servico.estado === "meio-aberto" || servico.falhas >= servico.limiteFalhas) {
    abrirServico(`${servico.falhas} falha(s) seguidas no banco`, "automatico");
  }
}

export function abrirServico(motivo, origem) {
  servico.estado = "aberto";
  servico.abertoAte = Date.now() + servico.esperaS * 1000;
  registrar("BREAKER_SERVICO_ABERTO", { motivo, origem, esperaS: servico.esperaS });
}

export function fecharServico() {
  servico.estado = "fechado";
  servico.falhas = 0;
  servico.abertoAte = 0;
  registrar("BREAKER_SERVICO_FECHADO", { motivo: "fechado pelo ADMIN" });
}

export function injetarFalha(segundos) {
  servico.falhaInjetadaAte = Date.now() + segundos * 1000;
  registrar("FALHA_BANCO_INJETADA", { segundos });
}

export function zerarProtecoes() {
  Object.assign(configMercado, { automatico: true, limitePct: 15, duracaoS: 30 });
  Object.assign(servico, { estado: "fechado", falhas: 0, abertoAte: 0, falhaInjetadaAte: 0 });
}

export function falhaInjetada() {
  return Date.now() < servico.falhaInjetadaAte;
}

export function estadoProtecoes() {
  const agora = Date.now();
  return {
    mercado: {
      ...configMercado,
      suspensoAte: mercado.ate > agora ? new Date(mercado.ate).toISOString() : null,
      motivo: mercado.ate > agora ? mercado.motivo : null,
      ativos: [...suspensos].map(([ticker, s]) => ({
        ticker,
        ate: new Date(s.ate).toISOString(),
        motivo: s.motivo,
        origem: s.origem,
      })),
      referencias: Object.fromEntries(referencias),
    },
    servico: {
      estado: servico.estado === "aberto" && agora >= servico.abertoAte ? "meio-aberto (aguardando teste)" : servico.estado,
      falhas: servico.falhas,
      limiteFalhas: servico.limiteFalhas,
      esperaS: servico.esperaS,
      abertoAte: servico.abertoAte > agora ? new Date(servico.abertoAte).toISOString() : null,
      falhaInjetadaAte: servico.falhaInjetadaAte > agora ? new Date(servico.falhaInjetadaAte).toISOString() : null,
    },
  };
}
