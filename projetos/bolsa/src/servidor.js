import "dotenv/config";
import { criarApp } from "./app.js";
import { esperarMysql, pool } from "./banco.js";
import { quantidadeConectada } from "./hub.js";
import { migrar } from "./migracoes.js";
import { iniciarAgentes, estadoAgentes } from "./mercado/agentes.js";
import { iniciarCaos } from "./mercado/caos.js";
import { iniciarMundo } from "./mercado/mundo.js";
import { tamanhoFila } from "./mercado/ordens.js";
import { estadoProtecoes } from "./mercado/protecao.js";
import { iniciarMonitor, registrarFonte } from "./observabilidade.js";
import { registrar, registrarErro } from "./log.js";

const porta = Number(process.env.PORT || 3000);

process.on("unhandledRejection", (erro) => registrarErro("ERRO_NAO_TRATADO", erro));

await esperarMysql();
await migrar();
await pool.query("UPDATE ativos SET preco_abertura_centavos = preco_centavos");
registrar("PREGAO_ABERTO", { referencia: "último preço vira preço de abertura da sessão" });

registrarFonte("mysql", async () => {
  const inicio = performance.now();
  await pool.query("SELECT 1");
  return { ok: true, pingMs: Number((performance.now() - inicio).toFixed(1)) };
});
registrarFonte("fila", () => ({ pendentes: tamanhoFila() }));
registrarFonte("sse", () => ({ clientes: quantidadeConectada() }));
registrarFonte("protecoes", () => estadoProtecoes());
registrarFonte("agentes", async () => {
  const { ligados, intervaloMs, porRodada, ativos, rodadas } = await estadoAgentes();
  return { ligados, intervaloMs, porRodada, ativos, rodadas };
});
iniciarMonitor();
await iniciarMundo();

if (process.env.AGENTES !== "0") {
  await iniciarAgentes();
}
iniciarCaos();

criarApp().listen(porta, () => {
  registrar("SERVIDOR_PRONTO", { porta });
});
