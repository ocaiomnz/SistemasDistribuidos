import { createHash } from "node:crypto";

const LIMITE_ENTRADAS = 2000;
const LIMITE_HISTORICO = 90;
const HASH_INICIAL = "0".repeat(64);

const entradas = [];
const assinantes = new Set();
const fontes = new Map();
const historico = [];
const latencias = [];
const marcas = { ordens: [], negocios: [] };
const contadores = {
  ordensAceitas: 0,
  ordensRejeitadas: 0,
  negocios: 0,
  cancelamentos: 0,
  errosInfra: 0,
  erros: 0,
  eventosSeguranca: 0,
};

let sequencia = 0;
let ultimoHash = HASH_INICIAL;
let ultimoSnapshot = null;
let cpuAnterior = process.cpuUsage();
let instanteAnterior = performance.now();
let atrasoLoopMs = 0;

function calcularHash(anterior, corpo) {
  return createHash("sha256").update(`${anterior}|${corpo}`).digest("hex");
}

function difundir(pacote) {
  const texto = `data: ${JSON.stringify(pacote)}\n\n`;
  for (const resposta of assinantes) {
    try {
      resposta.write(texto);
    } catch {
      assinantes.delete(resposta);
    }
  }
}

export function anexar(registro) {
  sequencia += 1;
  const corpo = JSON.stringify({ seq: sequencia, ...registro });
  const anterior = ultimoHash;
  const hash = calcularHash(anterior, corpo);
  ultimoHash = hash;
  const entrada = { seq: sequencia, anterior, hash, corpo };
  entradas.push(entrada);
  if (entradas.length > LIMITE_ENTRADAS) entradas.shift();
  difundir({ tipo: "log", entrada });
  return entrada;
}

export function recentes(limite = 300) {
  return entradas.slice(-limite).map(({ seq, anterior, hash, corpo }) => ({ seq, anterior, hash, corpo }));
}

export function verificarCadeia() {
  for (let i = 0; i < entradas.length; i += 1) {
    const entrada = entradas[i];
    if (calcularHash(entrada.anterior, entrada.corpo) !== entrada.hash) {
      return { integra: false, verificados: i, quebraEm: entrada.seq, motivo: "conteúdo não bate com o hash" };
    }
    if (i > 0 && entrada.anterior !== entradas[i - 1].hash) {
      return { integra: false, verificados: i, quebraEm: entrada.seq, motivo: "elo com o registro anterior rompido" };
    }
  }
  return { integra: true, verificados: entradas.length, quebraEm: null, ultimoHash };
}

export function adulterarRegistro() {
  const candidatos = entradas.slice(-60, -5).filter((entrada) => !entrada.original);
  if (candidatos.length === 0) return null;
  const alvo = candidatos[Math.floor(Math.random() * candidatos.length)];
  alvo.original = alvo.corpo;
  const dados = JSON.parse(alvo.corpo);
  dados.adulterado = true;
  if (typeof dados.precoCentavos === "number") dados.precoCentavos += 1;
  alvo.corpo = JSON.stringify(dados);
  return alvo.seq;
}

export function restaurarRegistros() {
  let restaurados = 0;
  for (const entrada of entradas) {
    if (entrada.original) {
      entrada.corpo = entrada.original;
      delete entrada.original;
      restaurados += 1;
    }
  }
  return restaurados;
}

export function assinar(resposta) {
  assinantes.add(resposta);
  return () => assinantes.delete(resposta);
}

export function quantidadeAssinantes() {
  return assinantes.size;
}

export function contar(nome, quantidade = 1) {
  contadores[nome] = (contadores[nome] || 0) + quantidade;
}

export function marcarOrdem(latenciaMs, negocios) {
  const agora = Date.now();
  latencias.push(latenciaMs);
  if (latencias.length > 500) latencias.shift();
  marcas.ordens.push(agora);
  for (let i = 0; i < negocios; i += 1) marcas.negocios.push(agora);
}

export function zerarMetricas() {
  for (const nome of Object.keys(contadores)) contadores[nome] = 0;
  latencias.length = 0;
  marcas.ordens.length = 0;
  marcas.negocios.length = 0;
  historico.length = 0;
}

export function registrarFonte(nome, fn) {
  fontes.set(nome, fn);
}

function porSegundo(lista, janelaMs = 10000) {
  const limite = Date.now() - janelaMs;
  while (lista.length && lista[0] < limite) lista.shift();
  return Number((lista.length / (janelaMs / 1000)).toFixed(2));
}

function percentil(valores, p) {
  if (valores.length === 0) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  return ordenados[Math.min(ordenados.length - 1, Math.floor(ordenados.length * p))];
}

async function montarSnapshot() {
  const agora = performance.now();
  const cpu = process.cpuUsage(cpuAnterior);
  const decorridoMs = agora - instanteAnterior;
  cpuAnterior = process.cpuUsage();
  instanteAnterior = agora;
  const memoria = process.memoryUsage();
  const media = latencias.length ? latencias.reduce((soma, v) => soma + v, 0) / latencias.length : 0;
  const snapshot = {
    em: new Date().toISOString(),
    uptimeS: Math.round(process.uptime()),
    memoriaMb: Number((memoria.rss / 1048576).toFixed(1)),
    heapMb: Number((memoria.heapUsed / 1048576).toFixed(1)),
    cpuPct: Number((((cpu.user + cpu.system) / 1000 / decorridoMs) * 100).toFixed(1)),
    atrasoLoopMs: Number(atrasoLoopMs.toFixed(1)),
    ordensPorSegundo: porSegundo(marcas.ordens),
    negociosPorSegundo: porSegundo(marcas.negocios),
    latenciaMediaMs: Number(media.toFixed(1)),
    latenciaP95Ms: Number(percentil(latencias, 0.95).toFixed(1)),
    contadores: { ...contadores },
    logs: { total: sequencia, assinantes: assinantes.size },
  };
  for (const [nome, fn] of fontes) {
    try {
      snapshot[nome] = await fn();
    } catch (erro) {
      snapshot[nome] = { ok: false, erro: erro.message };
    }
  }
  return snapshot;
}

export function iniciarMonitor(intervaloMs = 2000) {
  let esperado = Date.now() + 500;
  setInterval(() => {
    const agora = Date.now();
    atrasoLoopMs = Math.max(0, agora - esperado);
    esperado = agora + 500;
  }, 500).unref();

  setInterval(async () => {
    ultimoSnapshot = await montarSnapshot();
    historico.push(ultimoSnapshot);
    if (historico.length > LIMITE_HISTORICO) historico.shift();
    difundir({ tipo: "metricas", dados: ultimoSnapshot });
  }, intervaloMs).unref();
}

export async function snapshotAtual() {
  return ultimoSnapshot || montarSnapshot();
}

export function historicoMetricas() {
  return historico;
}
