import { ErroNegocio } from "./erros.js";
import { registrar } from "./log.js";

const PRECO_MAXIMO_CENTAVOS = 100_000_000;

export function asyncRota(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function exigirLogin(req, res, next) {
  if (!req.session.usuarioId) {
    if (req.originalUrl.startsWith("/api") || req.originalUrl === "/eventos") {
      registrar("ACESSO_NEGADO", { rota: req.originalUrl, motivo: "sem sessão", ip: req.ip });
      res.status(401).json({ erro: "Sessão ausente. Entre novamente." });
      return;
    }
    res.redirect("/entrar");
    return;
  }
  next();
}

export function paraCentavos(valor) {
  let texto = String(valor ?? "").trim();
  if (!texto) {
    throw new ErroNegocio("Informe o preço limite.", "validacao");
  }
  if (texto.includes(",")) {
    texto = texto.replace(/\./g, "").replace(",", ".");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(texto)) {
    throw new ErroNegocio("Preço inválido. Use um valor positivo com até duas casas, como 18,50.", "validacao");
  }
  const centavos = Math.round(Number(texto) * 100);
  if (centavos <= 0 || centavos > PRECO_MAXIMO_CENTAVOS) {
    throw new ErroNegocio("Preço fora do intervalo aceito, de R$ 0,01 a R$ 1.000.000,00.", "validacao");
  }
  return centavos;
}

export function quantidadeInteira(valor) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0 || numero > 100000) {
    throw new ErroNegocio("Quantidade deve ser um inteiro entre 1 e 100.000.", "validacao");
  }
  return numero;
}

export function tickerValido(valor) {
  const ticker = String(valor ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(ticker)) {
    throw new ErroNegocio("Ativo inválido. Escolha um dos papéis listados.", "validacao");
  }
  return ticker;
}

export function ladoValido(valor) {
  if (valor === "compra" || valor === "venda") return valor;
  throw new ErroNegocio("Lado da ordem deve ser compra ou venda.", "validacao");
}

export function inteiroEntre(valor, minimo, maximo, rotulo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < minimo || numero > maximo) {
    throw new ErroNegocio(`${rotulo} deve ser um inteiro entre ${minimo} e ${maximo}.`, "validacao");
  }
  return numero;
}

export function numeroEntre(valor, minimo, maximo, rotulo) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < minimo || numero > maximo) {
    throw new ErroNegocio(`${rotulo} deve ficar entre ${minimo} e ${maximo}.`, "validacao");
  }
  return numero;
}

export function reais(centavos) {
  return (Number(centavos) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}
