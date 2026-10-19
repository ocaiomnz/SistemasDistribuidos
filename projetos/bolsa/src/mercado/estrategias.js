export const PERFIS = {
  conservador: { rotulo: "Conservador", fracao: 0.02, descricao: "Só compra com desconto sobre o valor que enxerga; ordens passivas, sem cruzar o spread." },
  agressivo: { rotulo: "Agressivo", fracao: 0.06, descricao: "Cruza o spread quando acha o preço errado; reage rápido às notícias." },
  momentum: { rotulo: "Momentum", fracao: 0.05, descricao: "Segue a tendência recente na maior parte das vezes." },
  contrarian: { rotulo: "Contrarian", fracao: 0.05, descricao: "Aposta contra a tendência recente." },
  aleatorio: { rotulo: "Aleatório", fracao: 0.03, descricao: "Lado e preço sorteados até 3% do último negócio; ignora notícias." },
  formador: { rotulo: "Formador de mercado", fracao: 0.02, descricao: "Mantém compra e venda em volta do valor percebido, dando liquidez." },
};

export const PERFIS_SORTEAVEIS = Object.keys(PERFIS);

const MAX_DESVIO_POR_ORDEM = 0.05;

function entre(minimo, maximo) {
  return minimo + Math.random() * (maximo - minimo);
}

function limitar(valor, minimo, maximo) {
  return Math.min(maximo, Math.max(minimo, valor));
}

function viesDe(agenteId, ticker) {
  let semente = agenteId * 2654435761;
  for (const letra of ticker) semente = (semente ^ letra.charCodeAt(0)) * 16777619;
  return ((Math.abs(semente) % 1000) / 1000 - 0.5) * 0.08;
}

function opiniaoDe(agente, ctx) {
  const base = ctx.percebido ?? ctx.ultimo;
  return base * (1 + viesDe(agente.id ?? 0, ctx.ticker) + entre(-0.01, 0.01));
}

function chanceDeComprar(desconto, confianca) {
  return limitar(0.5 + desconto * 8 + (confianca / 100) * 0.15, 0.05, 0.95);
}

function ladoDe(perfil, ctx, desconto) {
  const { tendencia, confianca = 0 } = ctx;
  const chance = chanceDeComprar(desconto, confianca);
  const sorteio = Math.random();
  switch (perfil) {
    case "conservador":
      if (Math.abs(desconto) < 0.01) return null;
      return desconto > 0 ? "compra" : "venda";
    case "agressivo":
      return sorteio < chance ? "compra" : "venda";
    case "momentum":
      if (Math.abs(tendencia) >= 0.5 && Math.random() < 0.7) return tendencia > 0 ? "compra" : "venda";
      return sorteio < chance ? "compra" : "venda";
    case "contrarian":
      if (Math.abs(tendencia) >= 0.5 && Math.random() < 0.7) return tendencia > 0 ? "venda" : "compra";
      return sorteio < chance ? "compra" : "venda";
    default:
      return sorteio < 0.5 ? "compra" : "venda";
  }
}

function precoDe(perfil, lado, ctx, opiniao) {
  const { ultimo, melhorCompra, melhorVenda, tendencia } = ctx;
  switch (perfil) {
    case "conservador":
      return lado === "compra" ? Math.min(ultimo * 0.995, opiniao) : Math.max(ultimo * 1.005, opiniao);
    case "agressivo":
      if (lado === "compra") return melhorVenda && melhorVenda <= opiniao * 1.01 ? melhorVenda : Math.min(ultimo * 1.01, opiniao);
      return melhorCompra && melhorCompra >= opiniao * 0.99 ? melhorCompra : Math.max(ultimo * 0.99, opiniao);
    case "momentum":
    case "contrarian":
      if (Math.abs(tendencia) < 0.5) return lado === "compra" ? ultimo * 0.995 : ultimo * 1.005;
      if (lado === "compra") return melhorVenda ?? ultimo * 1.01;
      return melhorCompra ?? ultimo * 0.99;
    case "aleatorio":
      return ultimo * (1 + entre(-0.03, 0.03));
    case "formador": {
      const centro = (ultimo + opiniao) / 2;
      return lado === "compra" ? centro * 0.995 : centro * 1.005;
    }
    default:
      return ultimo;
  }
}

function quantidadePara(agente, perfil, lado, preco, alavancagem, conviccao, confianca) {
  const livre = agente.livres[agente.ticker] || 0;
  const humor = lado === "compra" ? 1 + confianca / 200 : 1 - confianca / 200;
  const valorAlvo = ((agente.saldoCentavos + livre * preco) * PERFIS[perfil].fracao * alavancagem * conviccao * humor) / 5;
  if (lado === "compra") {
    return Math.min(1000, Math.floor(Math.min(valorAlvo, agente.saldoCentavos) / preco));
  }
  return Math.min(livre, 1000, Math.max(1, Math.floor(valorAlvo / preco)));
}

function razoavel(preco, ultimo) {
  return preco && Math.abs(preco - ultimo) / ultimo <= MAX_DESVIO_POR_ORDEM + 0.01 ? preco : null;
}

export function decidir(perfil, contexto, agente, alavancagem = 1) {
  const conhecido = PERFIS[perfil] ? perfil : "conservador";
  const ctx = {
    ...contexto,
    melhorCompra: razoavel(contexto.melhorCompra, contexto.ultimo),
    melhorVenda: razoavel(contexto.melhorVenda, contexto.ultimo),
  };
  const opiniao = opiniaoDe(agente, ctx);
  const desconto = (opiniao - ctx.ultimo) / ctx.ultimo;
  const conviccao = limitar(0.4 + Math.abs(desconto) * 20, 0.4, 2);
  let lado = ladoDe(conhecido, ctx, desconto);
  if (!lado) return null;
  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    const bruto = precoDe(conhecido, lado, ctx, opiniao);
    const precoCentavos = Math.max(1, Math.round(limitar(bruto, ctx.ultimo * (1 - MAX_DESVIO_POR_ORDEM), ctx.ultimo * (1 + MAX_DESVIO_POR_ORDEM))));
    const quantidade = quantidadePara({ ...agente, ticker: ctx.ticker }, conhecido, lado, precoCentavos, alavancagem, conviccao, ctx.confianca ?? 0);
    if (quantidade >= 1) return { lado, precoCentavos, quantidade, opiniaoCentavos: Math.round(opiniao) };
    lado = lado === "compra" ? "venda" : "compra";
  }
  return null;
}
