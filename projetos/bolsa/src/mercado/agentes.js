import { numero, pool } from "../banco.js";
import { registrar, registrarErro } from "../log.js";
import { cancelarOrdem, enviarOrdem } from "./ordens.js";
import { contextoDoAtivo, listarAtivos, livresDoUsuario, ordensAbertasDe, visaoSemProprias } from "./consultas.js";
import { PERFIS, PERFIS_SORTEAVEIS, decidir } from "./estrategias.js";
import { configCaos, hashRobo, rodarRoleta } from "./caos.js";
import { carteiraEquilibrada, mundoPausado, percepcao } from "./mundo.js";

const FUNDADORES = [
  { nome: "Ana Conservadora", email: "agente-ana@bolsa.local", perfil: "conservador" },
  { nome: "Bruno Agressivo", email: "agente-bruno@bolsa.local", perfil: "agressivo" },
];

export const configAgentes = { ligados: true, intervaloMs: 2000, porRodada: 3 };

let ocupado = false;
let relogio = null;
let rodadas = 0;

async function criarAgente({ nome, email, perfil, capitalCentavos, fracaoEmAcoes, ativos, hash }) {
  const carteira = carteiraEquilibrada(capitalCentavos, fracaoEmAcoes, ativos);
  const [insercao] = await pool.query(
    `INSERT INTO usuarios (nome, email, senha_hash, saldo_centavos, capital_inicial_centavos, agente, perfil)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [nome, email, hash, carteira.caixaCentavos, capitalCentavos, perfil]
  );
  for (const posicao of carteira.posicoes) {
    await pool.query(
      `INSERT INTO posicoes (usuario_id, ativo_id, quantidade, quantidade_reservada, preco_medio_centavos)
       VALUES (?, ?, ?, 0, ?)`,
      [insercao.insertId, posicao.ativoId, posicao.quantidade, posicao.precoCentavos]
    );
  }
  return insercao.insertId;
}

async function garantirFundador(fundador) {
  const [existentes] = await pool.query("SELECT id FROM usuarios WHERE email = ?", [fundador.email]);
  if (existentes.length > 0) return existentes[0].id;
  const id = await criarAgente({
    ...fundador,
    capitalCentavos: 50_000_000,
    fracaoEmAcoes: 0.5,
    ativos: await listarAtivos(),
    hash: await hashRobo(),
  });
  registrar("AGENTE_CRIADO", { id, perfil: fundador.perfil });
  return id;
}

export async function criarRobos({ quantidade, perfis, capitalMinCentavos, capitalMaxCentavos }) {
  const escolhidos = perfis?.length ? perfis : PERFIS_SORTEAVEIS;
  const hash = await hashRobo();
  const ativos = await listarAtivos();
  const lote = Date.now().toString(36);
  const contagem = {};
  for (let i = 0; i < quantidade; i += 1) {
    const perfil = escolhidos[Math.floor(Math.random() * escolhidos.length)];
    await criarAgente({
      nome: `Robô ${PERFIS[perfil].rotulo} ${lote}-${i + 1}`,
      email: `robo-${lote}-${i + 1}@bolsa.local`,
      perfil,
      capitalCentavos: Math.round(capitalMinCentavos + Math.random() * (capitalMaxCentavos - capitalMinCentavos)),
      fracaoEmAcoes: 0.3 + Math.random() * 0.4,
      ativos,
      hash,
    });
    contagem[perfil] = (contagem[perfil] || 0) + 1;
  }
  registrar("BOTS_CRIADOS", { quantidade, lote, perfis: contagem, capitalMinCentavos, capitalMaxCentavos });
  return { quantidade, lote, perfis: contagem };
}

export async function encerrarRobos() {
  const [robos] = await pool.query(
    "SELECT id FROM usuarios WHERE agente = 1 AND email LIKE 'robo-%' AND estado = 'ativo'"
  );
  await pool.query("UPDATE usuarios SET estado = 'encerrado' WHERE agente = 1 AND email LIKE 'robo-%' AND estado = 'ativo'");
  let canceladas = 0;
  for (const { id } of robos) {
    for (const ordemId of await ordensAbertasDe(id)) {
      try {
        await cancelarOrdem(id, ordemId);
        canceladas += 1;
      } catch {
        // já executada
      }
    }
  }
  registrar("BOTS_ENCERRADOS", { quantidade: robos.length, ordensCanceladas: canceladas });
  return { quantidade: robos.length, ordensCanceladas: canceladas };
}

async function enxugar(usuarioId, ticker) {
  const abertas = await ordensAbertasDe(usuarioId, ticker);
  if (abertas.length < 4) return;
  try {
    await cancelarOrdem(usuarioId, abertas[0]);
  } catch {
    // já executada
  }
}

function sortear(lista, quantidade) {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia.slice(0, quantidade);
}

async function agir(agente, contextos) {
  const contexto = contextos[Math.floor(Math.random() * contextos.length)];
  await enxugar(agente.id, contexto.ticker);
  const { livres } = await livresDoUsuario(agente.id);
  const mundo = percepcao(contexto.ticker);
  const decisao = decidir(
    agente.perfil,
    { ...visaoSemProprias(contexto, agente.id), percebido: mundo?.percebidoCentavos, confianca: mundo?.confianca ?? 0 },
    { id: agente.id, saldoCentavos: numero(agente.saldo_centavos), livres },
    configCaos.alavancagem
  );
  if (!decisao) return;
  const { lado, precoCentavos, quantidade } = decisao;
  try {
    await enviarOrdem({ usuarioId: agente.id, ticker: contexto.ticker, lado, precoCentavos, quantidade, origem: "agente" });
  } catch {
    // rejeições de agentes (saldo, breaker) já entram nas métricas
  }
}

async function rodada() {
  if (ocupado || !configAgentes.ligados || mundoPausado()) return;
  ocupado = true;
  try {
    rodadas += 1;
    const [agentes] = await pool.query(
      `SELECT id, nome, email, perfil, saldo_centavos FROM usuarios
       WHERE agente = 1 AND estado = 'ativo' AND (perfil IS NULL OR perfil <> 'baleia')`
    );
    if (agentes.length === 0) return;
    const ativos = await listarAtivos();
    const contextos = (await Promise.all(ativos.map((ativo) => contextoDoAtivo(ativo.ticker)))).filter(Boolean);
    const daVez = sortear(agentes, configAgentes.porRodada);
    for (const agente of daVez) await agir(agente, contextos);
    await rodarRoleta(daVez);
  } catch (erro) {
    registrarErro("AGENTE_ERRO", erro);
  } finally {
    ocupado = false;
  }
}

export function configurarAgentes({ ligados, intervaloMs, porRodada }) {
  if (typeof ligados === "boolean") configAgentes.ligados = ligados;
  if (porRodada) configAgentes.porRodada = porRodada;
  if (intervaloMs && intervaloMs !== configAgentes.intervaloMs) {
    configAgentes.intervaloMs = intervaloMs;
    clearInterval(relogio);
    relogio = setInterval(rodada, configAgentes.intervaloMs);
  }
  registrar("ADMIN_RITMO_AGENTES", { ...configAgentes });
  return { ...configAgentes };
}

export async function estadoAgentes() {
  const [linhas] = await pool.query(
    `SELECT COALESCE(perfil, 'sem perfil') AS perfil, estado, COUNT(*) AS n
     FROM usuarios WHERE agente = 1 GROUP BY perfil, estado`
  );
  const porPerfil = {};
  let ativos = 0;
  for (const linha of linhas) {
    porPerfil[linha.perfil] ||= {};
    porPerfil[linha.perfil][linha.estado] = numero(linha.n);
    if (linha.estado === "ativo") ativos += numero(linha.n);
  }
  return { ...configAgentes, rodadas, ativos, porPerfil };
}

export function agentesOcupados() {
  return ocupado;
}

export async function zerarAgentes() {
  Object.assign(configAgentes, { ligados: true, intervaloMs: 2000, porRodada: 3 });
  rodadas = 0;
  clearInterval(relogio);
  for (const fundador of FUNDADORES) await garantirFundador(fundador);
  relogio = setInterval(rodada, configAgentes.intervaloMs);
}

export async function iniciarAgentes() {
  for (const fundador of FUNDADORES) await garantirFundador(fundador);
  relogio = setInterval(rodada, configAgentes.intervaloMs);
  registrar("AGENTES_INICIADOS", { ...configAgentes });
}
