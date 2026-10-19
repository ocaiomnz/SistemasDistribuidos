import bcrypt from "bcryptjs";
import { pool } from "./banco.js";
import { registrar } from "./log.js";

export const PRECOS_DE_LISTAGEM = { CIAJ3: 1850, PSER4: 3640, BSFR3: 2890, TXIN4: 1425 };

async function colunaExiste(tabela, coluna) {
  const [linhas] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [tabela, coluna]
  );
  return Number(linhas[0].n) > 0;
}

async function adicionarColuna(tabela, coluna, definicao) {
  if (await colunaExiste(tabela, coluna)) return;
  await pool.query(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
  registrar("MIGRACAO_APLICADA", { tabela, coluna });
}

async function restricaoExiste(nome) {
  const [linhas] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.table_constraints
     WHERE table_schema = DATABASE() AND constraint_name = ?`,
    [nome]
  );
  return Number(linhas[0].n) > 0;
}

async function adicionarRestricao(tabela, nome, condicao) {
  if (await restricaoExiste(nome)) return;
  try {
    await pool.query(`ALTER TABLE ${tabela} ADD CONSTRAINT ${nome} CHECK (${condicao})`);
    registrar("MIGRACAO_APLICADA", { tabela, restricao: nome });
  } catch (erro) {
    registrar("MIGRACAO_AVISO", { tabela, restricao: nome, mensagem: erro.message }, "aviso");
  }
}

async function indiceExiste(tabela, nome) {
  const [linhas] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [tabela, nome]
  );
  return Number(linhas[0].n) > 0;
}

async function garantirAdmin() {
  const email = (process.env.ADMIN_EMAIL || "admin@bolsa.local").toLowerCase();
  const senha = process.env.ADMIN_SENHA || "admin123";
  const capital = Number(process.env.CAPITAL_INICIAL_CENTAVOS || 10_000_000);
  const [linhas] = await pool.query("SELECT id, papel FROM usuarios WHERE email = ?", [email]);
  if (linhas.length > 0) {
    if (linhas[0].papel !== "admin") {
      await pool.query("UPDATE usuarios SET papel = 'admin' WHERE id = ?", [linhas[0].id]);
    }
    return;
  }
  const hash = await bcrypt.hash(senha, 10);
  await pool.query(
    `INSERT INTO usuarios (nome, email, senha_hash, saldo_centavos, capital_inicial_centavos, agente, papel)
     VALUES ('Administrador', ?, ?, ?, ?, 0, 'admin')`,
    [email, hash, capital, capital]
  );
  registrar("ADMIN_CRIADO", { email });
}

export async function migrar() {
  await adicionarColuna("usuarios", "papel", "ENUM('investidor', 'admin') NOT NULL DEFAULT 'investidor'");
  await adicionarColuna("usuarios", "perfil", "VARCHAR(20) NULL");
  await adicionarColuna("usuarios", "estado", "VARCHAR(16) NOT NULL DEFAULT 'ativo'");
  await adicionarColuna("usuarios", "divida_centavos", "BIGINT NOT NULL DEFAULT 0");
  await adicionarColuna("usuarios", "sacado_centavos", "BIGINT NOT NULL DEFAULT 0");
  await adicionarColuna("usuarios", "plano", "JSON NULL");
  await adicionarColuna("eventos", "contra_ordem_id", "INT NULL");
  if (!(await indiceExiste("eventos", "idx_evento_contra"))) {
    await pool.query("CREATE INDEX idx_evento_contra ON eventos (contra_ordem_id, id)");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS testes_carga (
      id INT AUTO_INCREMENT PRIMARY KEY,
      usuarios INT NOT NULL,
      ordens_por_usuario INT NOT NULL,
      enviadas INT NOT NULL,
      aceitas INT NOT NULL,
      rejeitadas INT NOT NULL,
      duracao_ms INT NOT NULL,
      ordens_por_segundo DECIMAL(10, 2) NOT NULL,
      latencia_media_ms INT NOT NULL,
      latencia_p95_ms INT NOT NULL,
      latencia_max_ms INT NOT NULL,
      cpu_pct DECIMAL(6, 1) NOT NULL,
      memoria_mb DECIMAL(8, 1) NOT NULL,
      criado_em TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB
  `);

  await adicionarColuna("ativos", "fundamento_centavos", "BIGINT NULL");
  for (const [ticker, preco] of Object.entries(PRECOS_DE_LISTAGEM)) {
    await pool.query("UPDATE ativos SET fundamento_centavos = ? WHERE ticker = ? AND fundamento_centavos IS NULL", [preco, ticker]);
  }
  await pool.query("UPDATE ativos SET fundamento_centavos = preco_centavos WHERE fundamento_centavos IS NULL");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS noticias (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticker VARCHAR(8) NULL,
      titulo VARCHAR(120) NOT NULL,
      impacto_pct DECIMAL(6, 2) NOT NULL,
      origem VARCHAR(16) NOT NULL,
      admin_id INT NULL,
      fundamentos JSON NULL,
      criada_em TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB
  `);

  await adicionarRestricao("usuarios", "chk_saldo_nao_negativo", "saldo_centavos >= 0");
  await adicionarRestricao(
    "posicoes",
    "chk_posicao_valida",
    "quantidade >= 0 AND quantidade_reservada >= 0 AND quantidade_reservada <= quantidade"
  );
  await adicionarRestricao(
    "ordens",
    "chk_ordem_valida",
    "quantidade > 0 AND quantidade_restante >= 0 AND quantidade_restante <= quantidade AND preco_centavos > 0"
  );

  await pool.query("UPDATE usuarios SET perfil = 'conservador' WHERE email = 'agente-ana@bolsa.local' AND perfil IS NULL");
  await pool.query("UPDATE usuarios SET perfil = 'agressivo' WHERE email = 'agente-bruno@bolsa.local' AND perfil IS NULL");
  await garantirAdmin();
}
