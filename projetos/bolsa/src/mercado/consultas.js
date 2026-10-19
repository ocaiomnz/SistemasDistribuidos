import { numero, pool } from "../banco.js";

const ABERTAS = "('aberta', 'parcial')";

export async function listarAtivos() {
  const [linhas] = await pool.query(
    "SELECT id, ticker, nome, preco_centavos, preco_abertura_centavos, fundamento_centavos, volume FROM ativos ORDER BY ticker"
  );
  return linhas.map((ativo) => ({
    id: numero(ativo.id),
    ticker: ativo.ticker,
    nome: ativo.nome,
    precoCentavos: numero(ativo.preco_centavos),
    precoAberturaCentavos: numero(ativo.preco_abertura_centavos),
    fundamentoCentavos: numero(ativo.fundamento_centavos ?? ativo.preco_centavos),
    volume: numero(ativo.volume),
  }));
}

export async function livro(ticker) {
  const [compras] = await pool.query(
    `SELECT o.id, o.preco_centavos, o.quantidade_restante, o.criada_em, u.nome
     FROM ordens o
     JOIN ativos a ON a.id = o.ativo_id
     JOIN usuarios u ON u.id = o.usuario_id
     WHERE a.ticker = ? AND o.lado = 'compra' AND o.status IN ${ABERTAS}
     ORDER BY o.preco_centavos DESC, o.criada_em ASC
     LIMIT 8`,
    [ticker]
  );
  const [vendas] = await pool.query(
    `SELECT o.id, o.preco_centavos, o.quantidade_restante, o.criada_em, u.nome
     FROM ordens o
     JOIN ativos a ON a.id = o.ativo_id
     JOIN usuarios u ON u.id = o.usuario_id
     WHERE a.ticker = ? AND o.lado = 'venda' AND o.status IN ${ABERTAS}
     ORDER BY o.preco_centavos ASC, o.criada_em ASC
     LIMIT 8`,
    [ticker]
  );
  const mapear = (linha) => ({
    id: numero(linha.id),
    precoCentavos: numero(linha.preco_centavos),
    quantidade: numero(linha.quantidade_restante),
    investidor: linha.nome,
    criadaEm: linha.criada_em,
  });
  return { compras: compras.map(mapear), vendas: vendas.map(mapear) };
}

export async function negociacoesRecentes(ticker) {
  const [linhas] = await pool.query(
    `SELECT n.id, n.quantidade, n.preco_centavos, n.executada_em, c.nome AS comprador, v.nome AS vendedor
     FROM negociacoes n
     JOIN ativos a ON a.id = n.ativo_id
     JOIN usuarios c ON c.id = n.comprador_id
     JOIN usuarios v ON v.id = n.vendedor_id
     WHERE a.ticker = ?
     ORDER BY n.id DESC
     LIMIT 15`,
    [ticker]
  );
  return linhas.map((linha) => ({
    id: numero(linha.id),
    quantidade: numero(linha.quantidade),
    precoCentavos: numero(linha.preco_centavos),
    executadaEm: linha.executada_em,
    comprador: linha.comprador,
    vendedor: linha.vendedor,
  }));
}

export async function carteira(usuarioId) {
  const [usuarios] = await pool.query(
    "SELECT nome, email, saldo_centavos, capital_inicial_centavos FROM usuarios WHERE id = ?",
    [usuarioId]
  );
  if (usuarios.length === 0) throw new Error("Investidor não encontrado");
  const usuario = usuarios[0];
  const [posicoes] = await pool.query(
    `SELECT a.ticker, a.nome, a.preco_centavos, p.quantidade, p.quantidade_reservada, p.preco_medio_centavos
     FROM posicoes p
     JOIN ativos a ON a.id = p.ativo_id
     WHERE p.usuario_id = ? AND p.quantidade > 0
     ORDER BY a.ticker`,
    [usuarioId]
  );
  const [reservas] = await pool.query(
    `SELECT COALESCE(SUM(preco_centavos * quantidade_restante), 0) AS reservado
     FROM ordens
     WHERE usuario_id = ? AND lado = 'compra' AND status IN ${ABERTAS}`,
    [usuarioId]
  );
  const saldo = numero(usuario.saldo_centavos);
  const reservado = numero(reservas[0].reservado);
  const mercado = posicoes.reduce(
    (total, posicao) => total + numero(posicao.quantidade) * numero(posicao.preco_centavos),
    0
  );
  const capital = numero(usuario.capital_inicial_centavos);
  return {
    nome: usuario.nome,
    email: usuario.email,
    saldoCentavos: saldo,
    reservadoCentavos: reservado,
    capitalInicialCentavos: capital,
    patrimonioCentavos: saldo + reservado + mercado,
    lucroCentavos: saldo + reservado + mercado - capital,
    posicoes: posicoes.map((posicao) => ({
      ticker: posicao.ticker,
      nome: posicao.nome,
      quantidade: numero(posicao.quantidade),
      quantidadeReservada: numero(posicao.quantidade_reservada),
      precoMedioCentavos: numero(posicao.preco_medio_centavos),
      precoCentavos: numero(posicao.preco_centavos),
      resultadoCentavos: (numero(posicao.preco_centavos) - numero(posicao.preco_medio_centavos)) * numero(posicao.quantidade),
    })),
  };
}

export async function ordensDoUsuario(usuarioId) {
  const [linhas] = await pool.query(
    `SELECT o.id, a.ticker, o.lado, o.quantidade, o.quantidade_restante, o.preco_centavos, o.status, o.criada_em
     FROM ordens o
     JOIN ativos a ON a.id = o.ativo_id
     WHERE o.usuario_id = ?
     ORDER BY o.id DESC
     LIMIT 30`,
    [usuarioId]
  );
  return linhas.map((linha) => ({
    id: numero(linha.id),
    ticker: linha.ticker,
    lado: linha.lado,
    quantidade: numero(linha.quantidade),
    quantidadeRestante: numero(linha.quantidade_restante),
    precoCentavos: numero(linha.preco_centavos),
    status: linha.status,
    criadaEm: linha.criada_em,
  }));
}

export async function contextoDoAtivo(ticker) {
  const [ativos] = await pool.query("SELECT id, ticker, preco_centavos FROM ativos WHERE ticker = ?", [ticker]);
  if (ativos.length === 0) return null;
  const ativo = ativos[0];
  const [ofertas] = await pool.query(
    `(SELECT usuario_id, lado, preco_centavos FROM ordens
      WHERE ativo_id = ? AND lado = 'compra' AND status IN ${ABERTAS}
      ORDER BY preco_centavos DESC, id ASC LIMIT 12)
     UNION ALL
     (SELECT usuario_id, lado, preco_centavos FROM ordens
      WHERE ativo_id = ? AND lado = 'venda' AND status IN ${ABERTAS}
      ORDER BY preco_centavos ASC, id ASC LIMIT 12)`,
    [ativo.id, ativo.id]
  );
  const [precos] = await pool.query(
    "SELECT preco_centavos FROM negociacoes WHERE ativo_id = ? ORDER BY id DESC LIMIT 20",
    [ativo.id]
  );
  const recente = precos.length ? numero(precos[0].preco_centavos) : numero(ativo.preco_centavos);
  const antigo = precos.length ? numero(precos.at(-1).preco_centavos) : recente;
  return {
    ativoId: numero(ativo.id),
    ticker,
    ultimo: numero(ativo.preco_centavos),
    tendencia: ((recente - antigo) / antigo) * 100,
    ofertas: ofertas.map((o) => ({
      usuarioId: numero(o.usuario_id),
      lado: o.lado,
      precoCentavos: numero(o.preco_centavos),
    })),
  };
}

export function visaoSemProprias(contexto, usuarioId) {
  const alheias = contexto.ofertas.filter((oferta) => oferta.usuarioId !== usuarioId);
  const compra = alheias.find((oferta) => oferta.lado === "compra");
  const venda = alheias.find((oferta) => oferta.lado === "venda");
  return {
    ticker: contexto.ticker,
    ultimo: contexto.ultimo,
    tendencia: contexto.tendencia,
    melhorCompra: compra?.precoCentavos ?? null,
    melhorVenda: venda?.precoCentavos ?? null,
  };
}

export async function livresDoUsuario(usuarioId) {
  const [linhas] = await pool.query(
    `SELECT a.ticker, p.quantidade, p.quantidade_reservada
     FROM posicoes p JOIN ativos a ON a.id = p.ativo_id
     WHERE p.usuario_id = ?`,
    [usuarioId]
  );
  const livres = {};
  const totais = {};
  for (const linha of linhas) {
    totais[linha.ticker] = numero(linha.quantidade);
    livres[linha.ticker] = numero(linha.quantidade) - numero(linha.quantidade_reservada);
  }
  return { livres, totais };
}

export async function ordensAbertasDe(usuarioId, ticker) {
  const [linhas] = await pool.query(
    `SELECT o.id FROM ordens o JOIN ativos a ON a.id = o.ativo_id
     WHERE o.usuario_id = ? AND o.status IN ${ABERTAS} ${ticker ? "AND a.ticker = ?" : ""}
     ORDER BY o.id ASC`,
    ticker ? [usuarioId, ticker] : [usuarioId]
  );
  return linhas.map((linha) => numero(linha.id));
}

export async function participacao(ticker, usuarioId) {
  const [linhas] = await pool.query(
    `SELECT COALESCE(SUM(p.quantidade), 0) AS total,
            COALESCE(SUM(CASE WHEN p.usuario_id = ? THEN p.quantidade ELSE 0 END), 0) AS dele
     FROM posicoes p JOIN ativos a ON a.id = p.ativo_id
     WHERE a.ticker = ?`,
    [usuarioId, ticker]
  );
  const total = numero(linhas[0].total);
  const dele = numero(linhas[0].dele);
  return { total, dele, pct: total ? (dele / total) * 100 : 0 };
}

export async function resultadoDosOutros(ticker, usuarioId) {
  const [linhas] = await pool.query(
    `SELECT COUNT(*) AS detentores, COALESCE(SUM(p.quantidade), 0) AS acoes,
            COALESCE(SUM((a.preco_centavos - p.preco_medio_centavos) * p.quantidade), 0) AS resultado
     FROM posicoes p JOIN ativos a ON a.id = p.ativo_id
     WHERE a.ticker = ? AND p.usuario_id <> ? AND p.quantidade > 0`,
    [ticker, usuarioId]
  );
  return {
    detentores: numero(linhas[0].detentores),
    acoes: numero(linhas[0].acoes),
    resultadoCentavos: numero(linhas[0].resultado),
  };
}

export async function historicoPrecos(ticker, limite = 80) {
  const [linhas] = await pool.query(
    `SELECT n.preco_centavos, n.executada_em
     FROM negociacoes n JOIN ativos a ON a.id = n.ativo_id
     WHERE a.ticker = ? ORDER BY n.id DESC LIMIT ?`,
    [ticker, limite]
  );
  return linhas.reverse().map((linha) => ({ precoCentavos: numero(linha.preco_centavos), em: linha.executada_em }));
}

export async function ranking() {
  const [linhas] = await pool.query(
    `SELECT u.id, u.nome, u.perfil, u.estado, u.agente, u.saldo_centavos, u.divida_centavos,
            u.sacado_centavos, u.capital_inicial_centavos,
            COALESCE((SELECT SUM(p.quantidade * a.preco_centavos) FROM posicoes p
                      JOIN ativos a ON a.id = p.ativo_id WHERE p.usuario_id = u.id), 0) AS mercado,
            COALESCE((SELECT SUM(o.preco_centavos * o.quantidade_restante) FROM ordens o
                      WHERE o.usuario_id = u.id AND o.lado = 'compra' AND o.status IN ${ABERTAS}), 0) AS reservado,
            (SELECT COUNT(*) FROM ordens o WHERE o.usuario_id = u.id) AS ordens
     FROM usuarios u
     WHERE u.papel <> 'admin'`
  );
  return linhas
    .map((linha) => {
      const patrimonio = numero(linha.saldo_centavos) + numero(linha.reservado) + numero(linha.mercado);
      const liquido = patrimonio - numero(linha.divida_centavos) + numero(linha.sacado_centavos);
      return {
        id: numero(linha.id),
        nome: linha.nome,
        perfil: linha.perfil || (linha.agente ? "agente" : "humano"),
        estado: linha.estado,
        agente: Boolean(linha.agente),
        saldoCentavos: numero(linha.saldo_centavos),
        dividaCentavos: numero(linha.divida_centavos),
        sacadoCentavos: numero(linha.sacado_centavos),
        capitalInicialCentavos: numero(linha.capital_inicial_centavos),
        patrimonioCentavos: patrimonio,
        lucroCentavos: liquido - numero(linha.capital_inicial_centavos),
        ordens: numero(linha.ordens),
      };
    })
    .sort((a, b) => b.lucroCentavos - a.lucroCentavos);
}

export async function trilhaDaOrdem(ordemId) {
  const [ordens] = await pool.query(
    `SELECT o.id, o.usuario_id, u.nome, u.agente, a.ticker, o.lado, o.quantidade, o.quantidade_restante,
            o.preco_centavos, o.status, o.criada_em
     FROM ordens o JOIN ativos a ON a.id = o.ativo_id JOIN usuarios u ON u.id = o.usuario_id
     WHERE o.id = ?`,
    [ordemId]
  );
  if (ordens.length === 0) return null;
  const [eventos] = await pool.query(
    `SELECT e.id, e.tipo, e.ordem_id, e.contra_ordem_id, e.usuario_id, e.detalhe, e.criado_em
     FROM eventos e
     WHERE e.ordem_id = ? OR e.contra_ordem_id = ?
        OR (e.tipo = 'CLIENTS_NOTIFIED' AND e.ordem_id IN (
              SELECT x.ordem_id FROM (SELECT ordem_id FROM eventos WHERE contra_ordem_id = ?) x))
     ORDER BY e.id ASC`,
    [ordemId, ordemId, ordemId]
  );
  const ordem = ordens[0];
  return {
    ordem: {
      id: numero(ordem.id),
      usuarioId: numero(ordem.usuario_id),
      investidor: ordem.nome,
      agente: Boolean(ordem.agente),
      ticker: ordem.ticker,
      lado: ordem.lado,
      quantidade: numero(ordem.quantidade),
      quantidadeRestante: numero(ordem.quantidade_restante),
      precoCentavos: numero(ordem.preco_centavos),
      status: ordem.status,
      criadaEm: ordem.criada_em,
    },
    eventos: eventos.map((evento) => ({
      id: numero(evento.id),
      tipo: evento.tipo,
      ordemId: numero(evento.ordem_id),
      contraOrdemId: evento.contra_ordem_id == null ? null : numero(evento.contra_ordem_id),
      usuarioId: evento.usuario_id == null ? null : numero(evento.usuario_id),
      papel: numero(evento.ordem_id) === Number(ordemId) ? "agressora" : "contraparte",
      detalhe: typeof evento.detalhe === "string" ? JSON.parse(evento.detalhe) : evento.detalhe,
      em: evento.criado_em,
    })),
  };
}

export async function ultimasOrdens(limite = 15) {
  const [linhas] = await pool.query(
    `SELECT o.id, a.ticker, o.lado, o.quantidade, o.preco_centavos, o.status, u.nome, u.agente, o.criada_em
     FROM ordens o JOIN ativos a ON a.id = o.ativo_id JOIN usuarios u ON u.id = o.usuario_id
     ORDER BY o.id DESC LIMIT ?`,
    [limite]
  );
  return linhas.map((linha) => ({
    id: numero(linha.id),
    ticker: linha.ticker,
    lado: linha.lado,
    quantidade: numero(linha.quantidade),
    precoCentavos: numero(linha.preco_centavos),
    status: linha.status,
    investidor: linha.nome,
    agente: Boolean(linha.agente),
    criadaEm: linha.criada_em,
  }));
}

export async function ordemDoUsuario(usuarioId, ordemId) {
  const [linhas] = await pool.query(
    `SELECT o.id, a.ticker, o.lado, o.quantidade, o.quantidade_restante, o.preco_centavos, o.status, o.criada_em
     FROM ordens o
     JOIN ativos a ON a.id = o.ativo_id
     WHERE o.id = ? AND o.usuario_id = ?`,
    [ordemId, usuarioId]
  );
  if (linhas.length === 0) return null;
  const linha = linhas[0];
  return {
    id: numero(linha.id),
    ticker: linha.ticker,
    lado: linha.lado,
    quantidade: numero(linha.quantidade),
    quantidadeRestante: numero(linha.quantidade_restante),
    precoCentavos: numero(linha.preco_centavos),
    status: linha.status,
    criadaEm: linha.criada_em,
  };
}
