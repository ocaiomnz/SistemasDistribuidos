import { anexar, contar } from "./observabilidade.js";

const CATEGORIAS = [
  [/^(ORDER_|MATCH_FOUND|TRADE_EXECUTED|PORTFOLIO_UPDATED|CLIENTS_NOTIFIED)/, "ordem"],
  [/^(LOGIN_|LOGOUT|CADASTRO|ACESSO_NEGADO|CSRF_BLOQUEADO|ORDEM_ALHEIA|VALIDACAO_|LIMITE_|SONDA_|LOG_)/, "seguranca"],
  [/^(CAOS_|BALEIA_|BREAKER_|MARGEM_|AGENTE_QUEBROU|FALHA_)/, "caos"],
  [/^MUNDO_/, "mundo"],
  [/^(ADMIN_|CARGA_|BOTS_)/, "admin"],
];

const AVISOS = /^(LOGIN_FALHOU|LOGIN_BLOQUEADO|ACESSO_NEGADO|CSRF_BLOQUEADO|ORDEM_ALHEIA_BLOQUEADA|VALIDACAO_REJEITADA|LIMITE_EXCEDIDO|ORDER_REJECTED|BREAKER_|MARGEM_|AGENTE_QUEBROU|BALEIA_QUEBROU|CAOS_QUEBRA|LOG_ADULTERADO|FALHA_)/;

export function registrar(evento, dados = {}, nivel) {
  const nivelFinal = nivel || (/ERRO/.test(evento) ? "erro" : AVISOS.test(evento) ? "aviso" : "info");
  const categoria = nivelFinal === "erro"
    ? "erro"
    : CATEGORIAS.find(([padrao]) => padrao.test(evento))?.[1] || "sistema";
  const registro = { ts: new Date().toISOString(), nivel: nivelFinal, categoria, evento, ...dados };
  console.log(JSON.stringify(registro));
  if (categoria === "seguranca") contar("eventosSeguranca");
  if (nivelFinal === "erro") contar("erros");
  anexar(registro);
}

export function registrarErro(evento, erro, dados = {}) {
  registrar(evento, { ...dados, mensagem: erro?.message || String(erro) }, "erro");
}
