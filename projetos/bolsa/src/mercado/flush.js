import { numero } from "../banco.js";
import { cargaEmAndamento } from "../carga.js";
import { ErroNegocio } from "../erros.js";
import { publicar } from "../hub.js";
import { registrar } from "../log.js";
import { PRECOS_DE_LISTAGEM } from "../migracoes.js";
import { zerarMetricas } from "../observabilidade.js";
import { agentesOcupados, zerarAgentes } from "./agentes.js";
import { caosOcupado, zerarCaos } from "./caos.js";
import { pausarMercado, zerarMundo } from "./mundo.js";
import { executarNaFila } from "./ordens.js";
import { redefinirReferencias, zerarProtecoes } from "./protecao.js";

const TABELAS_DE_MOVIMENTO = ["eventos", "negociacoes", "ordens", "posicoes", "noticias", "testes_carga"];
const TABELAS_COM_CONTADOR = ["eventos", "negociacoes", "ordens", "noticias", "testes_carga"];

let emAndamento = false;

async function esperarOciosos(limiteMs = 5000) {
  const fim = Date.now() + limiteMs;
  while ((agentesOcupados() || caosOcupado()) && Date.now() < fim) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function flushMercado({ adminId, apagarHumanos }) {
  if (cargaEmAndamento()) throw new ErroNegocio("Há um teste de carga rodando. Espere terminar antes de zerar o mercado.");
  if (emAndamento) return null;
  emAndamento = true;
  pausarMercado(true);
  try {
    await esperarOciosos();
    const capital = Number(process.env.CAPITAL_INICIAL_CENTAVOS || 10_000_000);
    const resumo = await executarNaFila(async (conexao) => {
      const apagados = {};
      for (const tabela of TABELAS_DE_MOVIMENTO) {
        const [resultado] = await conexao.query(`DELETE FROM ${tabela}`);
        apagados[tabela] = resultado.affectedRows;
      }
      const filtro = apagarHumanos
        ? "papel <> 'admin'"
        : "papel <> 'admin' AND (agente = 1 OR perfil IN ('carga', 'sonda', 'baleia'))";
      const [contas] = await conexao.query(`DELETE FROM usuarios WHERE ${filtro}`);
      const [mantidas] = await conexao.query(
        `UPDATE usuarios SET saldo_centavos = ?, capital_inicial_centavos = ?, divida_centavos = 0,
           sacado_centavos = 0, estado = 'ativo', plano = NULL`,
        [capital, capital]
      );
      for (const [ticker, preco] of Object.entries(PRECOS_DE_LISTAGEM)) {
        await conexao.query(
          `UPDATE ativos SET preco_centavos = ?, preco_abertura_centavos = ?, fundamento_centavos = ?, volume = 0
           WHERE ticker = ?`,
          [preco, preco, preco, ticker]
        );
      }
      if (apagarHumanos) {
        await conexao.query(`DELETE FROM sessions WHERE data NOT LIKE '%"papel":"admin"%'`);
      }
      // ALTER TABLE faz commit implícito; por isso só depois de todas as escritas.
      for (const tabela of TABELAS_COM_CONTADOR) {
        await conexao.query(`ALTER TABLE ${tabela} AUTO_INCREMENT = 1`);
      }
      return {
        apagados,
        contasApagadas: contas.affectedRows,
        contasMantidas: numero(mantidas.affectedRows),
        capitalPorContaCentavos: capital,
      };
    });

    zerarProtecoes();
    redefinirReferencias(PRECOS_DE_LISTAGEM, "flush do mercado");
    zerarCaos();
    zerarMetricas();
    await zerarMundo();
    await zerarAgentes();
    registrar("ADMIN_FLUSH_MERCADO", { adminId, apagarHumanos, ...resumo }, "aviso");
    publicar({ tipo: "MERCADO_ZERADO", em: new Date().toISOString() });
    publicar({ tipo: "MERCADO_ATUALIZADO", em: new Date().toISOString(), origem: "flush" });
    return resumo;
  } finally {
    pausarMercado(false);
    emAndamento = false;
  }
}
