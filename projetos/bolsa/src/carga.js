import bcrypt from "bcryptjs";
import { pool } from "./banco.js";
import { registrar, registrarErro } from "./log.js";
import { snapshotAtual } from "./observabilidade.js";
import { listarAtivos } from "./mercado/consultas.js";

let execucao = null;

function base() {
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

async function criarContas(quantidade, lote) {
  const senha = `carga-${lote}`;
  const hash = await bcrypt.hash(senha, 4);
  const capital = Number(process.env.CAPITAL_INICIAL_CENTAVOS || 10_000_000);
  const ativos = await listarAtivos();
  const valorDasAcoes = ativos.reduce((total, ativo) => total + 100 * ativo.precoCentavos, 0);
  const emails = [];
  for (let i = 1; i <= quantidade; i += 1) {
    const email = `carga-${lote}-${i}@bolsa.local`;
    const [insercao] = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, saldo_centavos, capital_inicial_centavos, agente, perfil)
       VALUES (?, ?, ?, ?, ?, 0, 'carga')`,
      [`Carga ${lote}-${i}`, email, hash, capital, capital + valorDasAcoes]
    );
    for (const ativo of ativos) {
      await pool.query(
        `INSERT INTO posicoes (usuario_id, ativo_id, quantidade, quantidade_reservada, preco_medio_centavos)
         VALUES (?, ?, 100, 0, ?)`,
        [insercao.insertId, ativo.id, ativo.precoCentavos]
      );
    }
    emails.push(email);
  }
  return { emails, senha, ativos };
}

async function entrar(email, senha) {
  const resposta = await fetch(`${base()}/entrar`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, senha }),
    redirect: "manual",
  });
  const cookie = (resposta.headers.getSetCookie?.() || []).map((item) => item.split(";")[0]).join("; ");
  if (resposta.status !== 302 || !cookie) throw new Error(`login de ${email} falhou (HTTP ${resposta.status})`);
  return cookie;
}

async function enviar(cookie, corpo) {
  const inicio = performance.now();
  try {
    const resposta = await fetch(`${base()}/api/ordens`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pregao": "1", cookie },
      body: JSON.stringify(corpo),
    });
    const json = await resposta.json();
    return { ok: resposta.ok, status: resposta.status, ms: performance.now() - inicio, erro: json.erro || null };
  } catch (erro) {
    return { ok: false, status: 0, ms: performance.now() - inicio, erro: erro.message };
  }
}

function ordemAleatoria(ativos) {
  const ativo = ativos[Math.floor(Math.random() * ativos.length)];
  const lado = Math.random() < 0.5 ? "compra" : "venda";
  const preco = Math.max(1, Math.round(ativo.precoCentavos * (1 + (Math.random() - 0.5) * 0.04)));
  return {
    ticker: ativo.ticker,
    lado,
    quantidade: 1 + Math.floor(Math.random() * 10),
    preco: (preco / 100).toFixed(2).replace(".", ","),
  };
}

async function rodar(usuarios, ordensPorUsuario) {
  const lote = Date.now().toString(36);
  registrar("CARGA_INICIADA", { usuarios, ordensPorUsuario, lote });
  execucao = { fase: "criando contas", usuarios, ordensPorUsuario, inicio: new Date().toISOString() };
  const { emails, senha } = await criarContas(usuarios, lote);
  execucao.fase = "autenticando";
  const cookies = await Promise.all(emails.map((email) => entrar(email, senha)));
  execucao.fase = "enviando ordens";
  const ativos = await listarAtivos();
  const inicio = performance.now();
  const tarefas = [];
  for (const cookie of cookies) {
    for (let n = 0; n < ordensPorUsuario; n += 1) tarefas.push(enviar(cookie, ordemAleatoria(ativos)));
  }
  const resultados = await Promise.all(tarefas);
  const duracao = performance.now() - inicio;
  const latencias = resultados.map((item) => item.ms).sort((a, b) => a - b);
  const media = latencias.reduce((soma, valor) => soma + valor, 0) / latencias.length;
  const sistema = await snapshotAtual();
  const motivos = {};
  for (const item of resultados.filter((r) => !r.ok)) {
    motivos[item.erro] = (motivos[item.erro] || 0) + 1;
  }
  const resumo = {
    usuarios,
    ordensPorUsuario,
    enviadas: resultados.length,
    aceitas: resultados.filter((item) => item.ok).length,
    rejeitadas: resultados.filter((item) => !item.ok).length,
    duracaoMs: Math.round(duracao),
    ordensPorSegundo: Number((resultados.length / (duracao / 1000)).toFixed(2)),
    latenciaMediaMs: Math.round(media),
    latenciaP95Ms: Math.round(latencias[Math.min(latencias.length - 1, Math.floor(latencias.length * 0.95))] || 0),
    latenciaMaxMs: Math.round(latencias.at(-1) || 0),
    cpuPct: sistema.cpuPct,
    memoriaMb: sistema.memoriaMb,
    motivosRejeicao: motivos,
  };
  await pool.query(
    `INSERT INTO testes_carga
      (usuarios, ordens_por_usuario, enviadas, aceitas, rejeitadas, duracao_ms, ordens_por_segundo,
       latencia_media_ms, latencia_p95_ms, latencia_max_ms, cpu_pct, memoria_mb)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      resumo.usuarios, resumo.ordensPorUsuario, resumo.enviadas, resumo.aceitas, resumo.rejeitadas,
      resumo.duracaoMs, resumo.ordensPorSegundo, resumo.latenciaMediaMs, resumo.latenciaP95Ms,
      resumo.latenciaMaxMs, resumo.cpuPct, resumo.memoriaMb,
    ]
  );
  registrar("CARGA_CONCLUIDA", resumo);
  return resumo;
}

export function iniciarCarga(usuarios, ordensPorUsuario) {
  if (execucao) return false;
  rodar(usuarios, ordensPorUsuario)
    .catch((erro) => registrarErro("CARGA_ERRO", erro, { usuarios, ordensPorUsuario }))
    .finally(() => {
      execucao = null;
    });
  return true;
}

export function cargaEmAndamento() {
  return execucao;
}

export async function historicoCarga() {
  const [linhas] = await pool.query("SELECT * FROM testes_carga ORDER BY id DESC LIMIT 12");
  return linhas.map((linha) => ({
    id: linha.id,
    usuarios: linha.usuarios,
    ordensPorUsuario: linha.ordens_por_usuario,
    enviadas: linha.enviadas,
    aceitas: linha.aceitas,
    rejeitadas: linha.rejeitadas,
    duracaoMs: linha.duracao_ms,
    ordensPorSegundo: Number(linha.ordens_por_segundo),
    latenciaMediaMs: linha.latencia_media_ms,
    latenciaP95Ms: linha.latencia_p95_ms,
    latenciaMaxMs: linha.latencia_max_ms,
    cpuPct: Number(linha.cpu_pct),
    memoriaMb: Number(linha.memoria_mb),
    criadoEm: linha.criado_em,
  }));
}
