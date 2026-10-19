import { Router } from "express";
import { ErroNegocio } from "../erros.js";
import { asyncRota, exigirLogin, ladoValido, paraCentavos, quantidadeInteira, tickerValido } from "../util.js";
import { adicionarCliente, publicar, quantidadeConectada, removerCliente } from "../hub.js";
import { registrar } from "../log.js";
import { snapshotAtual } from "../observabilidade.js";
import { limitarOrdens } from "../seguranca.js";
import { cancelarOrdem, enviarOrdem } from "../mercado/ordens.js";
import { noticiasRecentes } from "../mercado/mundo.js";
import { suspensaoDe } from "../mercado/protecao.js";
import {
  carteira,
  listarAtivos,
  livro,
  negociacoesRecentes,
  ordemDoUsuario,
  ordensDoUsuario,
} from "../mercado/consultas.js";

export const api = Router();

const CAMPOS_DA_ORDEM = new Set(["ticker", "lado", "quantidade", "preco"]);

function idDaRota(valor) {
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) throw new ErroNegocio("Identificador de ordem inválido.", "validacao");
  return id;
}

function validarPedido(req) {
  const extras = Object.keys(req.body || {}).filter((campo) => !CAMPOS_DA_ORDEM.has(campo));
  if (extras.length > 0) {
    throw new ErroNegocio(`Campo não permitido na ordem: ${extras.join(", ")}. O investidor vem da sessão, não do corpo.`, "validacao");
  }
  return {
    usuarioId: req.session.usuarioId,
    ticker: tickerValido(req.body.ticker),
    lado: ladoValido(req.body.lado),
    quantidade: quantidadeInteira(req.body.quantidade),
    precoCentavos: paraCentavos(req.body.preco),
  };
}

api.get("/api/mercado", exigirLogin, asyncRota(async (req, res) => {
  const ativos = (await listarAtivos()).map(({ fundamentoCentavos, ...ativo }) => ({ ...ativo, suspensao: suspensaoDe(ativo.ticker) }));
  const pedido = String(req.query.ticker || "").toUpperCase();
  const ticker = ativos.some((ativo) => ativo.ticker === pedido) ? pedido : ativos[0]?.ticker || "";
  const ofertas = ticker ? await livro(ticker) : { compras: [], vendas: [] };
  const negociacoes = ticker ? await negociacoesRecentes(ticker) : [];
  const noticias = (await noticiasRecentes(5)).map((noticia) => ({
    id: noticia.id,
    ticker: noticia.ticker,
    titulo: noticia.titulo,
    tom: noticia.impactoPct > 0 ? "positiva" : "negativa",
    em: noticia.em,
  }));
  res.json({
    ativos,
    ticker,
    ...ofertas,
    negociacoes,
    noticias,
    conectados: quantidadeConectada(),
  });
}));

api.get("/api/carteira", exigirLogin, asyncRota(async (req, res) => {
  res.json(await carteira(req.session.usuarioId));
}));

api.get("/api/ordens", exigirLogin, asyncRota(async (req, res) => {
  res.json(await ordensDoUsuario(req.session.usuarioId));
}));

api.get("/api/ordens/:id", exigirLogin, asyncRota(async (req, res) => {
  const ordem = await ordemDoUsuario(req.session.usuarioId, idDaRota(req.params.id));
  if (!ordem) {
    res.status(404).json({ erro: "Ordem não encontrada entre as suas." });
    return;
  }
  res.json(ordem);
}));

api.post("/api/ordens", exigirLogin, limitarOrdens, asyncRota(async (req, res) => {
  let pedido;
  try {
    pedido = validarPedido(req);
  } catch (erro) {
    registrar("VALIDACAO_REJEITADA", { usuarioId: req.session.usuarioId, rota: req.originalUrl, motivo: erro.message });
    throw erro;
  }
  const resultado = await enviarOrdem({ ...pedido, origem: req.session.papel === "admin" ? "admin" : "humano" });
  res.status(201).json(resultado);
}));

api.delete("/api/ordens/:id", exigirLogin, asyncRota(async (req, res) => {
  res.json(await cancelarOrdem(req.session.usuarioId, idDaRota(req.params.id)));
}));

api.get("/eventos", exigirLogin, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("retry: 2000\n\n");
  const cliente = adicionarCliente(req.session.usuarioId, res);
  registrar("CLIENTE_CONECTADO", { usuarioId: req.session.usuarioId, conectados: quantidadeConectada() });
  publicar({ tipo: "PRESENCA", em: new Date().toISOString(), conectados: quantidadeConectada() });
  req.on("close", () => {
    removerCliente(cliente);
    registrar("CLIENTE_DESCONECTADO", { usuarioId: req.session.usuarioId, conectados: quantidadeConectada() });
    publicar({ tipo: "PRESENCA", em: new Date().toISOString(), conectados: quantidadeConectada() });
  });
});

api.get("/metricas", exigirLogin, asyncRota(async (_req, res) => {
  res.json(await snapshotAtual());
}));
