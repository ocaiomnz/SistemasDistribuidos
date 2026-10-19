import mysql from "mysql2/promise";

const configuracao = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "bolsa",
  password: process.env.MYSQL_PASSWORD || "bolsa",
  database: process.env.MYSQL_DATABASE || "bolsa",
  waitForConnections: true,
  connectionLimit: 10,
  supportBigNumbers: true,
  bigNumberStrings: false,
  timezone: "Z",
};

export const pool = mysql.createPool(configuracao);

export function opcoesSessao() {
  return {
    host: configuracao.host,
    port: configuracao.port,
    user: configuracao.user,
    password: configuracao.password,
    database: configuracao.database,
  };
}

export async function esperarMysql() {
  let ultimoErro = null;
  for (let tentativa = 1; tentativa <= 30; tentativa += 1) {
    try {
      const conexao = await pool.getConnection();
      await conexao.query("SELECT 1");
      conexao.release();
      return;
    } catch (erro) {
      ultimoErro = erro;
      await new Promise((resolver) => setTimeout(resolver, 2000));
    }
  }
  throw new Error(`MySQL indisponível: ${ultimoErro?.message || "sem detalhe"}`);
}

export async function transacao(fn) {
  const conexao = await pool.getConnection();
  try {
    await conexao.beginTransaction();
    const resultado = await fn(conexao);
    await conexao.commit();
    return resultado;
  } catch (erro) {
    await conexao.rollback();
    throw erro;
  } finally {
    conexao.release();
  }
}

export function numero(valor) {
  return Number(valor);
}
