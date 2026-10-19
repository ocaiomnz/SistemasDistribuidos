import { numero, pool, transacao } from "../banco.js";
import { ErroAcesso, ErroNegocio, ehFalhaDeInfra } from "../erros.js";
import { publicar, quantidadeConectada } from "../hub.js";
import { registrar } from "../log.js";
import { contar, marcarOrdem } from "../observabilidade.js";
import {
  antesDeExecutar,
  aposFalha,
  aposSucesso,
  avaliarPreco,
  falhaInjetada,
  rejeitarSeAberto,
  verificarNegociacao,
} from "./protecao.js";

let cadeia = Promise.resolve();
let pendentes = 0;

function emFila(fn) {
  pendentes += 1;
  const resultado = cadeia.then(fn).finally(() => {
    pendentes -= 1;
  });
  cadeia = resultado.then(
    () => {},
    () => {}
  );
  return resultado;
}

export function tamanhoFila() {
  return pendentes;
}

export function executarNaFila(fn) {
  return emFila(() => transacao(fn));
}

async function registrarEvento(conexao, tipo, ordemId, usuarioId, detalhe, contraOrdemId = null) {
  await conexao.query(
    "INSERT INTO eventos (tipo, ordem_id, contra_ordem_id, usuario_id, detalhe) VALUES (?, ?, ?, ?, ?)",
    [tipo, ordemId, contraOrdemId, usuarioId, JSON.stringify(detalhe)]
  );
  registrar(tipo, { ordemId, contraOrdemId: contraOrdemId ?? undefined, usuarioId, ...detalhe });
}

function statusDaOrdem(quantidade, restante) {
  if (restante <= 0) return "executada";
  if (restante < quantidade) return "parcial";
  return "aberta";
}

async function atualizarStatus(conexao, ordem) {
  const status = statusDaOrdem(ordem.quantidade, ordem.quantidade_restante);
  await conexao.query(
    "UPDATE ordens SET quantidade_restante = ?, status = ? WHERE id = ?",
    [ordem.quantidade_restante, status, ordem.id]
  );
  ordem.status = status;
}

async function creditarComprador(conexao, usuarioId, ativoId, quantidade, preco) {
  const [linhas] = await conexao.query(
    "SELECT quantidade, preco_medio_centavos FROM posicoes WHERE usuario_id = ? AND ativo_id = ? FOR UPDATE",
    [usuarioId, ativoId]
  );
  if (linhas.length === 0) {
    await conexao.query(
      "INSERT INTO posicoes (usuario_id, ativo_id, quantidade, quantidade_reservada, preco_medio_centavos) VALUES (?, ?, ?, 0, ?)",
      [usuarioId, ativoId, quantidade, preco]
    );
    return;
  }
  const atual = linhas[0];
  const quantidadeAtual = numero(atual.quantidade);
  const novaQuantidade = quantidadeAtual + quantidade;
  const novoMedio = Math.round(
    (quantidadeAtual * numero(atual.preco_medio_centavos) + quantidade * preco) / novaQuantidade
  );
  await conexao.query(
    "UPDATE posicoes SET quantidade = ?, preco_medio_centavos = ? WHERE usuario_id = ? AND ativo_id = ?",
    [novaQuantidade, novoMedio, usuarioId, ativoId]
  );
}

async function executarNegocio(conexao, agressora, oferta, ativo, quantidade, preco) {
  const compra = agressora.lado === "compra" ? agressora : oferta;
  const venda = agressora.lado === "venda" ? agressora : oferta;
  compra.quantidade_restante = numero(compra.quantidade_restante) - quantidade;
  venda.quantidade_restante = numero(venda.quantidade_restante) - quantidade;
  await atualizarStatus(conexao, compra);
  await atualizarStatus(conexao, venda);

  const diferenca = (numero(compra.preco_centavos) - preco) * quantidade;
  if (diferenca > 0) {
    await conexao.query(
      "UPDATE usuarios SET saldo_centavos = saldo_centavos + ? WHERE id = ?",
      [diferenca, compra.usuario_id]
    );
  }
  await conexao.query(
    "UPDATE usuarios SET saldo_centavos = saldo_centavos + ? WHERE id = ?",
    [preco * quantidade, venda.usuario_id]
  );
  await conexao.query(
    "UPDATE posicoes SET quantidade = quantidade - ?, quantidade_reservada = quantidade_reservada - ? WHERE usuario_id = ? AND ativo_id = ?",
    [quantidade, quantidade, venda.usuario_id, ativo.id]
  );
  await creditarComprador(conexao, compra.usuario_id, ativo.id, quantidade, preco);
  await conexao.query(
    "UPDATE ativos SET preco_centavos = ?, volume = volume + ? WHERE id = ?",
    [preco, quantidade, ativo.id]
  );
  const [negocio] = await conexao.query(
    `INSERT INTO negociacoes
      (ativo_id, ordem_compra_id, ordem_venda_id, comprador_id, vendedor_id, quantidade, preco_centavos)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ativo.id, compra.id, venda.id, compra.usuario_id, venda.usuario_id, quantidade, preco]
  );
  await registrarEvento(conexao, "TRADE_EXECUTED", agressora.id, agressora.usuario_id, {
    negocioId: negocio.insertId,
    ticker: ativo.ticker,
    ordemCompraId: compra.id,
    ordemVendaId: venda.id,
    quantidade,
    precoCentavos: preco,
  }, oferta.id);
  await registrarEvento(conexao, "PORTFOLIO_UPDATED", agressora.id, agressora.usuario_id, {
    negocioId: negocio.insertId,
    compradorId: compra.usuario_id,
    vendedorId: venda.usuario_id,
    acoes: quantidade,
    valorCentavos: preco * quantidade,
  }, oferta.id);
}

async function casar(conexao, ordem, ativo) {
  const ladoOposto = ordem.lado === "compra" ? "venda" : "compra";
  const comparacao = ordem.lado === "compra" ? "<=" : ">=";
  const ordemPreco = ordem.lado === "compra" ? "ASC" : "DESC";
  const [ofertas] = await conexao.query(
    `SELECT * FROM ordens
     WHERE ativo_id = ? AND lado = ? AND status IN ('aberta', 'parcial')
       AND preco_centavos ${comparacao} ? AND usuario_id <> ?
     ORDER BY preco_centavos ${ordemPreco}, criada_em ASC, id ASC
     FOR UPDATE`,
    [ativo.id, ladoOposto, ordem.preco_centavos, ordem.usuario_id]
  );

  const negocios = [];
  for (const oferta of ofertas) {
    if (ordem.quantidade_restante === 0) break;
    const quantidade = Math.min(numero(ordem.quantidade_restante), numero(oferta.quantidade_restante));
    const preco = numero(oferta.preco_centavos);
    await registrarEvento(conexao, "MATCH_FOUND", ordem.id, ordem.usuario_id, {
      ticker: ativo.ticker,
      quantidade,
      precoCentavos: preco,
      contraparteId: numero(oferta.usuario_id),
    }, oferta.id);
    await executarNegocio(conexao, ordem, oferta, ativo, quantidade, preco);
    negocios.push({ quantidade, precoCentavos: preco, contraOrdemId: oferta.id });
  }
  return negocios;
}

async function reservar(conexao, usuarioId, ativo, lado, quantidade, precoCentavos) {
  if (lado === "compra") {
    const custo = quantidade * precoCentavos;
    const [usuarios] = await conexao.query(
      "SELECT saldo_centavos FROM usuarios WHERE id = ? FOR UPDATE",
      [usuarioId]
    );
    if (usuarios.length === 0) throw new ErroAcesso("Investidor não encontrado.");
    if (numero(usuarios[0].saldo_centavos) < custo) {
      throw new ErroNegocio("Saldo insuficiente. Reduza a quantidade ou o preço limite.");
    }
    await conexao.query(
      "UPDATE usuarios SET saldo_centavos = saldo_centavos - ? WHERE id = ?",
      [custo, usuarioId]
    );
    return;
  }

  const [posicoes] = await conexao.query(
    "SELECT quantidade, quantidade_reservada FROM posicoes WHERE usuario_id = ? AND ativo_id = ? FOR UPDATE",
    [usuarioId, ativo.id]
  );
  const livre = posicoes.length === 0
    ? 0
    : numero(posicoes[0].quantidade) - numero(posicoes[0].quantidade_reservada);
  if (livre < quantidade) {
    throw new ErroNegocio("Ações livres insuficientes. Venda no máximo o que não está reservado em outra ordem.");
  }
  await conexao.query(
    "UPDATE posicoes SET quantidade_reservada = quantidade_reservada + ? WHERE usuario_id = ? AND ativo_id = ?",
    [quantidade, usuarioId, ativo.id]
  );
}

async function gravarOrdem(conexao, pedido) {
  if (falhaInjetada()) {
    throw new Error("Falha simulada do banco (injetada pelo ADMIN na aba O Caos)");
  }
  const [ativos] = await conexao.query(
    "SELECT * FROM ativos WHERE ticker = ? FOR UPDATE",
    [pedido.ticker]
  );
  if (ativos.length === 0) throw new ErroNegocio("Ativo não encontrado.", "validacao");
  const ativo = ativos[0];
  ativo.id = numero(ativo.id);

  await reservar(conexao, pedido.usuarioId, ativo, pedido.lado, pedido.quantidade, pedido.precoCentavos);
  const [insercao] = await conexao.query(
    `INSERT INTO ordens
      (usuario_id, ativo_id, lado, quantidade, quantidade_restante, preco_centavos, status)
     VALUES (?, ?, ?, ?, ?, ?, 'aberta')`,
    [pedido.usuarioId, ativo.id, pedido.lado, pedido.quantidade, pedido.quantidade, pedido.precoCentavos]
  );
  const ordem = {
    id: insercao.insertId,
    usuario_id: pedido.usuarioId,
    lado: pedido.lado,
    quantidade: pedido.quantidade,
    quantidade_restante: pedido.quantidade,
    preco_centavos: pedido.precoCentavos,
    status: "aberta",
  };
  await registrarEvento(conexao, "ORDER_RECEIVED", ordem.id, pedido.usuarioId, {
    ticker: pedido.ticker,
    lado: pedido.lado,
    quantidade: pedido.quantidade,
    precoCentavos: pedido.precoCentavos,
    origem: pedido.origem,
    recebidoEm: new Date(pedido.recebidoEm).toISOString(),
    esperaFilaMs: Date.now() - pedido.recebidoEm,
  });
  await registrarEvento(conexao, "ORDER_VALIDATED", ordem.id, pedido.usuarioId, {
    ticker: pedido.ticker,
    reserva: pedido.lado === "compra"
      ? { saldoCentavos: pedido.quantidade * pedido.precoCentavos }
      : { acoes: pedido.quantidade },
  });
  await registrarEvento(conexao, "ORDER_BOOK_INSERTED", ordem.id, pedido.usuarioId, {
    ticker: pedido.ticker,
    lado: pedido.lado,
  });
  const negocios = await casar(conexao, ordem, ativo);
  await atualizarStatus(conexao, ordem);
  return {
    ordemId: ordem.id,
    status: ordem.status,
    quantidadeRestante: ordem.quantidade_restante,
    negocios,
    ticker: pedido.ticker,
  };
}

async function notificarClientes(ordemId, usuarioId, detalhe) {
  const clientes = quantidadeConectada();
  try {
    await pool.query(
      "INSERT INTO eventos (tipo, ordem_id, usuario_id, detalhe) VALUES ('CLIENTS_NOTIFIED', ?, ?, ?)",
      [ordemId, usuarioId, JSON.stringify({ ...detalhe, clientes })]
    );
  } catch (erro) {
    registrar("ERRO_PERSISTIR_NOTIFICACAO", { ordemId, mensagem: erro.message });
  }
  registrar("CLIENTS_NOTIFIED", { ordemId, usuarioId, ...detalhe, clientes });
}

export async function enviarOrdem(pedido) {
  pedido.recebidoEm ||= Date.now();
  pedido.origem ||= "humano";
  try {
    rejeitarSeAberto();
    verificarNegociacao(pedido.ticker);
    const resultado = await emFila(async () => {
      antesDeExecutar();
      verificarNegociacao(pedido.ticker);
      try {
        const gravado = await transacao((conexao) => gravarOrdem(conexao, pedido));
        aposSucesso();
        return gravado;
      } catch (erro) {
        if (ehFalhaDeInfra(erro)) aposFalha(erro);
        throw erro;
      }
    });
    publicar({
      tipo: "MERCADO_ATUALIZADO",
      em: new Date().toISOString(),
      ticker: resultado.ticker,
      ordemId: resultado.ordemId,
    });
    await notificarClientes(resultado.ordemId, pedido.usuarioId, {
      ticker: resultado.ticker,
      negocios: resultado.negocios.length,
      latenciaMs: Date.now() - pedido.recebidoEm,
    });
    contar("ordensAceitas");
    contar("negocios", resultado.negocios.length);
    marcarOrdem(Date.now() - pedido.recebidoEm, resultado.negocios.length);
    if (resultado.negocios.length > 0) {
      avaliarPreco(resultado.ticker, resultado.negocios.at(-1).precoCentavos);
    }
    return resultado;
  } catch (erro) {
    contar("ordensRejeitadas");
    const infra = ehFalhaDeInfra(erro);
    if (infra) contar("errosInfra");
    if (infra || pedido.origem !== "agente" || erro.tipo === "breaker") {
      registrar("ORDER_REJECTED", {
        usuarioId: pedido.usuarioId,
        origem: pedido.origem,
        ticker: pedido.ticker,
        lado: pedido.lado,
        quantidade: pedido.quantidade,
        precoCentavos: pedido.precoCentavos,
        motivo: erro.message,
      }, infra ? "erro" : "aviso");
    }
    throw erro;
  }
}

async function devolverReserva(conexao, ordem) {
  if (ordem.lado === "compra") {
    const valor = numero(ordem.preco_centavos) * numero(ordem.quantidade_restante);
    await conexao.query(
      "UPDATE usuarios SET saldo_centavos = saldo_centavos + ? WHERE id = ?",
      [valor, ordem.usuario_id]
    );
    return;
  }
  await conexao.query(
    "UPDATE posicoes SET quantidade_reservada = quantidade_reservada - ? WHERE usuario_id = ? AND ativo_id = ?",
    [ordem.quantidade_restante, ordem.usuario_id, ordem.ativo_id]
  );
}

export async function cancelarOrdem(usuarioId, ordemId) {
  const resultado = await emFila(() => transacao(async (conexao) => {
    const [linhas] = await conexao.query(
      "SELECT * FROM ordens WHERE id = ? FOR UPDATE",
      [ordemId]
    );
    if (linhas.length === 0) throw new ErroNegocio("Ordem não encontrada.");
    const ordem = linhas[0];
    if (numero(ordem.usuario_id) !== Number(usuarioId)) {
      registrar("ORDEM_ALHEIA_BLOQUEADA", {
        usuarioId,
        ordemId: numero(ordemId),
        donoId: numero(ordem.usuario_id),
        acao: "cancelar",
      });
      throw new ErroAcesso("Esta ordem pertence a outro investidor. Só o dono pode cancelá-la.");
    }
    if (!["aberta", "parcial"].includes(ordem.status)) {
      throw new ErroNegocio("A ordem não está mais aberta.");
    }
    await devolverReserva(conexao, ordem);
    await conexao.query(
      "UPDATE ordens SET quantidade_restante = 0, status = 'cancelada' WHERE id = ?",
      [ordemId]
    );
    await registrarEvento(conexao, "ORDER_CANCELLED", numero(ordemId), usuarioId, {
      quantidadeDevolvida: numero(ordem.quantidade_restante),
    });
    return { ordemId: numero(ordem.id), status: "cancelada" };
  }));
  contar("cancelamentos");
  publicar({
    tipo: "ORDEM_CANCELADA",
    em: new Date().toISOString(),
    ordemId: resultado.ordemId,
  });
  await notificarClientes(resultado.ordemId, usuarioId, { tipo: "ORDEM_CANCELADA" });
  return resultado;
}
