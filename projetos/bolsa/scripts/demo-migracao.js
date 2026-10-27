import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import mysql from "mysql2/promise";

const BANCO_DEMO = process.env.DEMO_BANCO || "bolsa_demo_migracao";
const pausar = process.argv.includes("--pausar") && process.stdin.isTTY;
const manter = process.argv.includes("--manter");
const dadoInvalido = process.argv.includes("--dado-invalido");

const conexao = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.DEMO_ROOT_USUARIO || "root",
  password: process.env.DEMO_ROOT_SENHA || "root",
};

process.env.MYSQL_USER = conexao.user;
process.env.MYSQL_PASSWORD = conexao.password;
process.env.MYSQL_DATABASE = BANCO_DEMO;

const TABELAS_ORIGINAIS = ["usuarios", "ativos", "posicoes", "ordens", "negociacoes", "eventos"];
const CHAVES = {
  usuarios: "id",
  ativos: "id",
  posicoes: "usuario_id, ativo_id",
  ordens: "id",
  negociacoes: "id",
  eventos: "id",
};

let falhas = 0;
const terminal = pausar ? createInterface({ input: process.stdin, output: process.stdout }) : null;

async function etapa(numero, titulo) {
  console.log(`\n${"=".repeat(72)}\n ${numero}. ${titulo}\n${"=".repeat(72)}`);
  if (terminal) await terminal.question("   [Enter para continuar] ");
}

function ok(mensagem) {
  console.log(`   [ok]    ${mensagem}`);
}

function falhou(mensagem) {
  falhas += 1;
  console.log(`   [FALHA] ${mensagem}`);
}

function info(mensagem) {
  console.log(`   ${mensagem}`);
}

function linhas(n) {
  return `${n} ${n === 1 ? "linha" : "linhas"}`;
}

async function esquema(db) {
  const [colunas] = await db.query(
    `SELECT table_name AS tabela, column_name AS coluna, column_type AS tipo
     FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position`,
    [BANCO_DEMO]
  );
  const [restricoes] = await db.query(
    `SELECT table_name AS tabela, constraint_name AS nome
     FROM information_schema.table_constraints
     WHERE table_schema = ? AND constraint_type = 'CHECK' ORDER BY constraint_name`,
    [BANCO_DEMO]
  );
  const [indices] = await db.query(
    `SELECT DISTINCT table_name AS tabela, index_name AS nome
     FROM information_schema.statistics WHERE table_schema = ? ORDER BY table_name, index_name`,
    [BANCO_DEMO]
  );
  const tabelas = new Map();
  for (const { tabela, coluna, tipo } of colunas) {
    if (!tabelas.has(tabela)) tabelas.set(tabela, new Map());
    tabelas.get(tabela).set(coluna, tipo);
  }
  return {
    tabelas,
    restricoes: restricoes.map(({ tabela, nome }) => `${tabela}.${nome}`),
    indices: indices.map(({ tabela, nome }) => `${tabela}.${nome}`),
  };
}

function assinatura(retrato) {
  return JSON.stringify({
    tabelas: [...retrato.tabelas].map(([tabela, colunas]) => [tabela, [...colunas]]),
    restricoes: retrato.restricoes,
    indices: retrato.indices,
  });
}

function mostrarEsquema(retrato) {
  for (const [tabela, colunas] of retrato.tabelas) {
    info(`${tabela.padEnd(13)} ${String(colunas.size).padStart(2)} colunas: ${[...colunas.keys()].join(", ")}`);
  }
  info(`restrições CHECK: ${retrato.restricoes.length ? retrato.restricoes.join(", ") : "nenhuma"}`);
}

async function linhasOriginais(db, retrato) {
  const dados = {};
  for (const tabela of TABELAS_ORIGINAIS) {
    const colunas = [...retrato.tabelas.get(tabela).keys()].map((coluna) => `\`${coluna}\``).join(", ");
    const [linhas] = await db.query(`SELECT ${colunas} FROM ${tabela} ORDER BY ${CHAVES[tabela]}`);
    dados[tabela] = linhas.map((linha) => JSON.stringify(linha));
  }
  return dados;
}

async function popularVersaoAntiga(db) {
  const saldoDiego = dadoInvalido ? -50_000 : 4_200_000;
  await db.query(
    `INSERT INTO usuarios (id, nome, email, senha_hash, saldo_centavos, capital_inicial_centavos, agente) VALUES
      (1, 'Ana Conservadora', 'agente-ana@bolsa.local', '$2b$10$legado', 25000000, 50000000, 1),
      (2, 'Bruno Agressivo', 'agente-bruno@bolsa.local', '$2b$10$legado', 25000000, 50000000, 1),
      (3, 'Carla Investidora', 'carla@ufs.br', '$2b$10$legado', 9620000, 10000000, 0),
      (4, 'Diego Investidor', 'diego@ufs.br', '$2b$10$legado', ?, 10000000, 0)`,
    [saldoDiego]
  );
  await db.query(
    `INSERT INTO posicoes (usuario_id, ativo_id, quantidade, quantidade_reservada, preco_medio_centavos) VALUES
      (1, 1, 3000, 50, 1850), (1, 2, 1500, 0, 3640),
      (2, 3, 2000, 0, 2890), (2, 4, 4000, 100, 1425),
      (3, 1, 200, 0, 1900)`
  );
  await db.query(
    `INSERT INTO ordens (id, usuario_id, ativo_id, lado, quantidade, quantidade_restante, preco_centavos, status) VALUES
      (1, 1, 1, 'venda', 250, 50, 1900, 'parcial'),
      (2, 3, 1, 'compra', 200, 0, 1900, 'executada'),
      (3, 2, 4, 'venda', 100, 100, 1500, 'aberta'),
      (4, 4, 2, 'compra', 10, 10, 3500, 'cancelada')`
  );
  await db.query(
    `INSERT INTO negociacoes (ativo_id, ordem_compra_id, ordem_venda_id, comprador_id, vendedor_id, quantidade, preco_centavos)
     VALUES (1, 2, 1, 3, 1, 200, 1900)`
  );
  await db.query(
    `INSERT INTO eventos (tipo, ordem_id, usuario_id, detalhe) VALUES
      ('ORDER_RECEIVED', 2, 3, JSON_OBJECT('ticker', 'CIAJ3')),
      ('ORDER_VALIDATED', 2, 3, NULL),
      ('MATCH_FOUND', 2, 3, JSON_OBJECT('contra', 1)),
      ('TRADE_EXECUTED', 2, 3, JSON_OBJECT('quantidade', 200, 'precoCentavos', 1900)),
      ('CLIENTS_NOTIFIED', 2, 3, NULL)`
  );
  await db.query("UPDATE ativos SET preco_centavos = 1900, volume = 200 WHERE ticker = 'CIAJ3'");
}

async function tentarViolar(db, descricao, sql, restricao, retrato) {
  await db.beginTransaction();
  try {
    await db.query(sql);
    if (retrato.restricoes.includes(restricao)) {
      falhou(`${descricao}: o banco aceitou, mas ${restricao} deveria recusar`);
    } else {
      info(`[aceito] ${descricao}: ${restricao} não existe neste banco (veja o MIGRACAO_AVISO acima)`);
    }
  } catch (erro) {
    if (erro.errno === 3819) ok(`${descricao}: recusado pelo MySQL (${restricao})`);
    else falhou(`${descricao}: erro inesperado ${erro.code}: ${erro.message}`);
  } finally {
    await db.rollback();
  }
}

const db = await mysql.createConnection({
  ...conexao,
  multipleStatements: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  timezone: "Z",
});

await etapa(1, `Banco "${BANCO_DEMO}" na versão antiga (só sql/init.sql + dados de uso)`);
await db.query(`DROP DATABASE IF EXISTS \`${BANCO_DEMO}\``);
await db.query(`CREATE DATABASE \`${BANCO_DEMO}\` CHARACTER SET utf8mb4`);
await db.changeUser({ database: BANCO_DEMO });
await db.query(await readFile(new URL("../sql/init.sql", import.meta.url), "utf8"));
await popularVersaoAntiga(db);
const antes = await esquema(db);
const dadosAntes = await linhasOriginais(db, antes);
mostrarEsquema(antes);
info("");
for (const tabela of TABELAS_ORIGINAIS) info(`${tabela.padEnd(13)} ${linhas(dadosAntes[tabela].length)}`);
if (dadoInvalido) info("Diego foi gravado com saldo NEGATIVO de propósito (--dado-invalido).");

await etapa(2, "Servidor sobe e chama migrar() (o mesmo código de src/servidor.js)");
const { migrar } = await import("../src/migracoes.js");
const { pool } = await import("../src/banco.js");
const { recentes } = await import("../src/observabilidade.js");

function eventosDesde(seq) {
  return recentes(2000).filter((entrada) => entrada.seq > seq).map((entrada) => JSON.parse(entrada.corpo).evento);
}

function ultimoSeq() {
  return recentes(1)[0]?.seq || 0;
}

info("logs JSON emitidos pelo servidor (iguais aos de `docker compose logs pregao`):\n");
const seqAntes = ultimoSeq();
const inicio = performance.now();
await migrar();
const duracao = Math.round(performance.now() - inicio);
const primeiros = eventosDesde(seqAntes);
const aplicadas = primeiros.filter((evento) => evento === "MIGRACAO_APLICADA").length;
const avisos = primeiros.filter((evento) => evento === "MIGRACAO_AVISO").length;
info("");
info(`migrar() terminou em ${duracao} ms: ${aplicadas} alteração(ões) aplicada(s), ${avisos} aviso(s)`);

await etapa(3, "O que mudou no esquema");
const depois = await esquema(db);
for (const [tabela, colunas] of depois.tabelas) {
  if (!antes.tabelas.has(tabela)) {
    info(`+ tabela nova ${tabela} (${colunas.size} colunas)`);
    continue;
  }
  for (const [coluna, tipo] of colunas) {
    if (!antes.tabelas.get(tabela).has(coluna)) info(`+ coluna ${tabela}.${coluna} ${tipo}`);
  }
}
for (const nome of depois.restricoes.filter((nome) => !antes.restricoes.includes(nome))) info(`+ CHECK ${nome}`);
for (const nome of depois.indices.filter((nome) => !antes.indices.includes(nome))) info(`+ índice ${nome}`);
for (const tabela of antes.tabelas.keys()) {
  for (const coluna of antes.tabelas.get(tabela).keys()) {
    if (!depois.tabelas.get(tabela)?.has(coluna)) falhou(`coluna ${tabela}.${coluna} sumiu`);
  }
}

await etapa(4, "Nenhum dado se perdeu");
const dadosDepois = await linhasOriginais(db, antes);
for (const tabela of TABELAS_ORIGINAIS) {
  const existentes = new Set(dadosDepois[tabela]);
  const perdidas = dadosAntes[tabela].filter((linha) => !existentes.has(linha)).length;
  const novas = dadosDepois[tabela].length - dadosAntes[tabela].length + perdidas;
  const extra = novas > 0 ? `, ${novas} nova(s)` : "";
  const total = dadosAntes[tabela].length;
  const iguais = total === 1 ? "1 linha antiga idêntica" : `${total} linhas antigas idênticas`;
  if (perdidas === 0) ok(`${tabela.padEnd(13)} ${iguais}${extra}`);
  else falhou(`${tabela}: ${perdidas} linha(s) antiga(s) alteradas ou apagadas`);
}

info("\n   Colunas novas preenchidas para os dados que já existiam:");
const [contas] = await db.query("SELECT id, nome, papel, perfil, estado, divida_centavos FROM usuarios ORDER BY id");
for (const conta of contas) {
  info(`   #${conta.id} ${conta.nome.padEnd(18)} papel=${conta.papel.padEnd(10)} perfil=${String(conta.perfil).padEnd(11)} estado=${conta.estado} dívida=${conta.divida_centavos}`);
}
const ana = contas.find((conta) => conta.id === 1);
const bruno = contas.find((conta) => conta.id === 2);
if (ana?.perfil === "conservador" && bruno?.perfil === "agressivo") ok("Ana e Bruno receberam os perfis de robô");
else falhou("perfis de Ana e Bruno não foram preenchidos");
if (contas.some((conta) => conta.papel === "admin")) ok("conta ADMIN criada");
else falhou("conta ADMIN não foi criada");

const [ativos] = await db.query("SELECT ticker, preco_centavos, fundamento_centavos FROM ativos ORDER BY id");
for (const ativo of ativos) {
  info(`   ${ativo.ticker} preço=${ativo.preco_centavos} valor justo=${ativo.fundamento_centavos}`);
}
if (ativos.every((ativo) => ativo.fundamento_centavos !== null)) ok("valor justo preenchido com o preço de lançamento");
else falhou("algum ativo ficou sem valor justo");

await etapa(5, "Rodando migrar() de novo (reinício do contêiner)");
const contasAntes = contas.length;
const seqSegunda = ultimoSeq();
await migrar();
const segundos = eventosDesde(seqSegunda);
const reaplicadas = segundos.filter((evento) => evento === "MIGRACAO_APLICADA").length;
const reavisos = segundos.filter((evento) => evento === "MIGRACAO_AVISO").length;
if (reaplicadas === 0) ok("nenhuma alteração reaplicada");
else falhou(`${reaplicadas} alterações foram reaplicadas`);
if (reavisos > 0) info(`${reavisos} aviso(s) repetido(s): a restrição continua faltando enquanto o dado inválido existir`);
if (assinatura(await esquema(db)) === assinatura(depois)) ok("esquema idêntico ao da primeira execução");
else falhou("o esquema mudou na segunda execução");
const [[{ total }]] = await db.query("SELECT COUNT(*) AS total FROM usuarios");
if (Number(total) === contasAntes) ok("ADMIN não foi duplicado");
else falhou(`usuarios passou de ${contasAntes} para ${total}`);

await etapa(6, "As restrições criadas protegem os dados");
await tentarViolar(db, "saldo negativo", "UPDATE usuarios SET saldo_centavos = -1 WHERE id = 3", "usuarios.chk_saldo_nao_negativo", depois);
await tentarViolar(db, "reserva maior que a posição", "UPDATE posicoes SET quantidade_reservada = 999999 WHERE usuario_id = 3", "posicoes.chk_posicao_valida", depois);
await tentarViolar(db, "ordem com quantidade zero", "UPDATE ordens SET quantidade = 0 WHERE id = 3", "ordens.chk_ordem_valida", depois);

await pool.end();
if (manter) {
  info(`\n   Banco "${BANCO_DEMO}" mantido. No Adminer: servidor mysql, usuário ${conexao.user}, senha ${conexao.password}.`);
} else {
  await db.query(`DROP DATABASE IF EXISTS \`${BANCO_DEMO}\``);
  info(`\n   Banco "${BANCO_DEMO}" apagado (use --manter para inspecionar no Adminer).`);
}
await db.end();
terminal?.close();

console.log(falhas === 0 ? "\nDemonstração concluída sem falhas." : `\nDemonstração terminou com ${falhas} falha(s).`);
process.exitCode = falhas === 0 ? 0 : 1;
