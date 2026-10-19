const FASES = [
  ["acumulando", "Acumulando"],
  ["inflando", "Inflando o preço"],
  ["despejando", "Despejando"],
  ["saiu", "Sacou e saiu"],
];

const estado = { dados: null, configCarregada: false };

function duracao() {
  return Number(document.querySelector("#breaker-duracao").value);
}

function desenharBreaker({ protecoes, ativos }) {
  const mercado = protecoes.mercado;
  const resumo = document.querySelector("#breaker-resumo");
  resumo.textContent = mercado.suspensoAte
    ? `Mercado inteiro suspenso até ${hora(mercado.suspensoAte)}: ${mercado.motivo}.`
    : mercado.automatico
      ? `Disparo automático quando o preço varia ±${mercado.limitePct}% da referência; pausa de ${mercado.duracaoS} s.`
      : "Disparo automático desligado. Só o ADMIN suspende.";
  resumo.className = mercado.suspensoAte ? "legenda negativo" : "legenda";

  document.querySelector("#breaker-ativos").replaceChildren(...ativos.map((ativo) => {
    const referencia = mercado.referencias[ativo.ticker] || ativo.precoAberturaCentavos;
    const variacao = ((ativo.precoCentavos - referencia) / referencia) * 100;
    const perto = Math.abs(variacao) >= mercado.limitePct * 0.7;
    const suspenso = ativo.suspensao;
    const botao = suspenso
      ? el("button", { type: "button", classe: "secundario", texto: `Liberar ${ativo.ticker}`, onclick: (e) => comBotao(e.currentTarget, "Liberando…", async () => {
        await enviar("/api/admin/caos/breaker/liberar", { ticker: ativo.ticker });
        toast(`${ativo.ticker} voltou a negociar. A referência passa a ser o último preço.`, "ok");
        await carregar();
      }) })
      : el("button", { type: "button", classe: "perigo", texto: `Suspender ${ativo.ticker}`, onclick: (e) => comBotao(e.currentTarget, "Suspendendo…", async () => {
        await enviar("/api/admin/caos/breaker", { escopo: "ativo", ticker: ativo.ticker, duracaoS: duracao() });
        toast(`${ativo.ticker} suspenso por ${duracao()} s. Ordens novas serão recusadas.`, "ok");
        await carregar();
      }) });
    return el("tr", { classe: suspenso ? "suspenso" : "" },
      el("td", {}, el("strong", { texto: ativo.ticker }), el("p", { classe: "legenda", texto: ativo.nome })),
      el("td", { classe: "num", texto: reais(ativo.precoCentavos) }),
      el("td", { classe: `num ${variacao > 0 ? "positivo" : variacao < 0 ? "negativo" : ""}`, texto: `${pct(variacao)}${perto && !suspenso ? " · perto do limite" : ""}` }),
      el("td", {}, grafico(ativo.historico.map((item) => item.precoCentavos), { largura: 140, altura: 32 })),
      el("td", { classe: suspenso ? "negativo" : "positivo", texto: suspenso ? `Suspenso até ${hora(suspenso.ate)} · ${suspenso.motivo}` : "Negociando" }),
      el("td", {}, botao));
  }));

  if (!estado.configCarregada) {
    document.querySelector("#breaker-auto").checked = mercado.automatico;
    document.querySelector("#breaker-limite").value = mercado.limitePct;
    document.querySelector("#breaker-pausa").value = mercado.duracaoS;
  }
}

function desenharServico({ servico }) {
  const titulo = document.querySelector("#servico-estado");
  const fechado = servico.estado === "fechado";
  titulo.textContent = fechado ? "Fechado" : servico.estado.startsWith("aberto") ? "Aberto" : "Meio-aberto";
  titulo.className = `display ${fechado ? "positivo" : "negativo"}`;
  const partes = [`${servico.falhas} de ${servico.limiteFalhas} falhas seguidas`];
  if (servico.abertoAte) partes.push(`recusando ordens até ${hora(servico.abertoAte)}`);
  if (servico.falhaInjetadaAte) partes.push(`banco "fora do ar" até ${hora(servico.falhaInjetadaAte)}`);
  if (fechado && !servico.falhaInjetadaAte) partes.push("ordens fluindo normalmente");
  document.querySelector("#servico-contexto").textContent = partes.join(" · ");
}

function desenharAlavancagem(caos) {
  document.querySelector("#alavancagem-atual").textContent = `${numeroBr(caos.alavancagem, 1)}×`;
  if (!estado.configCarregada) {
    document.querySelector("#alavancagem").value = caos.alavancagem;
    document.querySelector("#alavancagem-saida").textContent = `${numeroBr(caos.alavancagem, 1)}×`;
    document.querySelector("#roleta-ativa").checked = caos.roleta.ativa;
    document.querySelector("#roleta-ganho").value = caos.roleta.chanceGanho * 100;
    document.querySelector("#roleta-quebra").value = caos.roleta.chanceQuebra * 100;
  }
}

function etapasBaleia(fase) {
  const atual = FASES.findIndex(([id]) => id === fase);
  return el("ol", { classe: "fases" }, FASES.map(([id, rotulo], indice) =>
    el("li", { classe: indice < atual ? "feito" : indice === atual ? "atual" : "", "aria-current": indice === atual ? "step" : null, texto: rotulo })));
}

function desenharBaleias(baleias, ativos) {
  const alvo = document.querySelector("#baleias");
  if (baleias.length === 0) {
    alvo.replaceChildren(el("p", { classe: "vazio" }, el("strong", { texto: "Nenhuma baleia no mercado." }), el("span", { classe: "legenda", texto: " Solte uma acima para ver o ciclo de manipulação acontecer." })));
    return;
  }
  alvo.replaceChildren(...baleias.map((baleia) => {
    const plano = baleia.plano;
    const ativo = ativos.find((item) => item.ticker === plano.ticker);
    const precoAtual = ativo?.precoCentavos ?? plano.precoEntradaCentavos;
    const fase = baleia.estado === "ativo" ? plano.fase : baleia.estado === "saiu" ? "saiu" : plano.fase;
    const participacao = plano.participacaoPct ?? 0;
    const metricas = [
      ["Participação no papel", `${numeroBr(participacao, 1)}%`, `meta ${plano.alvoParticipacaoPct}% · pico ${numeroBr(plano.participacaoMaxPct ?? 0, 1)}%`],
      baleia.estado === "ativo"
        ? ["Ganho sobre o preço médio", pct(plano.lucroPct ?? 0), `meta ${plano.alvoLucroPct}% · médio ${reais(plano.precoMedioCentavos ?? plano.precoEntradaCentavos)} · resultado ${reais(plano.resultadoCentavos ?? 0)}`]
        : ["Lucro realizado", reais(plano.lucroCentavos ?? 0), `sacou ${reais(baleia.sacadoCentavos)} · alavancagem ${plano.alavancagem}×`],
      [`Preço de ${plano.ticker}`, reais(precoAtual), `entrou a ${reais(plano.precoEntradaCentavos)} · pico ${reais(plano.precoPicoCentavos)}${plano.precoSaidaCentavos ? ` · saiu a ${reais(plano.precoSaidaCentavos)}` : ""}`],
      ["Valor perdido pelos outros desde o pico", reais(Math.max(0, plano.precoPicoCentavos - precoAtual) * baleia.acoesDosOutros),
        `${baleia.detentores} investidor(es) com ${numeroBr(baleia.acoesDosOutros)} ações · resultado sobre o médio ${reais(baleia.resultadoDosOutrosCentavos)}`],
    ];
    const acao = baleia.estado === "ativo" && plano.fase !== "despejando"
      ? el("button", { type: "button", classe: "perigo", texto: "Mandar despejar agora", onclick: (e) => comBotao(e.currentTarget, "Avisando…", async () => {
        await enviar(`/api/admin/caos/baleia/${baleia.id}/sair`);
        toast(`${baleia.nome} vai despejar as ações e sacar.`, "ok");
        await carregar();
      }) })
      : null;
    return el("article", { classe: `baleia ${baleia.estado}` },
      el("div", { classe: "cabeca-secao" },
        el("div", {}, el("h3", { texto: baleia.nome }), el("p", { classe: "legenda", texto: baleia.estado === "ativo"
          ? `Caixa ${reais(baleia.saldoCentavos)} · dívida ${reais(baleia.dividaCentavos)} · ${numeroBr(plano.acoes ?? 0)} ações`
          : `Fora do mercado · sacou ${reais(baleia.sacadoCentavos)} de um capital de ${reais(baleia.capitalCentavos)}` })),
        acao),
      etapasBaleia(fase),
      el("div", { classe: "barra", role: "img", "aria-label": `Participação de ${numeroBr(participacao, 1)}% no papel` },
        el("span", { style: `width: ${Math.min(100, participacao)}%` }),
        el("i", { style: `left: ${plano.alvoParticipacaoPct}%`, title: "Meta de participação" })),
      el("dl", { classe: "metricas quatro" }, metricas.map(([rotulo, valor, contexto]) =>
        el("div", {}, el("dt", { texto: rotulo }), el("dd", { texto: valor }), el("p", { classe: "legenda", texto: contexto })))));
  }));
}

function preencherTickers(ativos) {
  const seletor = document.querySelector("#baleia-ticker");
  if (seletor.options.length) return;
  seletor.replaceChildren(...ativos.map((ativo) => el("option", { value: ativo.ticker, texto: `${ativo.ticker} · ${ativo.nome}` })));
}

async function carregar() {
  const dados = await pegar("/api/admin/caos");
  estado.dados = dados;
  preencherTickers(dados.ativos);
  desenharBreaker(dados);
  desenharServico(dados.protecoes);
  desenharAlavancagem(dados.caos);
  desenharBaleias(dados.baleias, dados.ativos);
  estado.configCarregada = true;
  marcarAoVivo(`Atualizado às ${hora(new Date())}`);
}

document.querySelector("#suspender-mercado").addEventListener("click", (e) => comBotao(e.currentTarget, "Suspendendo…", async () => {
  await enviar("/api/admin/caos/breaker", { escopo: "mercado", duracaoS: duracao() });
  toast(`Mercado inteiro suspenso por ${duracao()} s.`, "ok");
  await carregar();
}));

document.querySelector("#liberar-tudo").addEventListener("click", (e) => comBotao(e.currentTarget, "Liberando…", async () => {
  await enviar("/api/admin/caos/breaker/liberar", {});
  toast("Todas as suspensões foram retiradas.", "ok");
  await carregar();
}));

document.querySelector("#form-breaker-config").addEventListener("submit", (evento) => {
  evento.preventDefault();
  comBotao(evento.submitter, "Salvando…", async () => {
    await enviar("/api/admin/caos/breaker/config", {
      automatico: document.querySelector("#breaker-auto").checked,
      limitePct: Number(document.querySelector("#breaker-limite").value),
      duracaoS: Number(document.querySelector("#breaker-pausa").value),
    });
    toast("Regra do circuit breaker salva.", "ok");
    await carregar();
  });
});

function acaoServico(acao, extra, mensagem) {
  return (e) => comBotao(e.currentTarget, "Aplicando…", async () => {
    await enviar("/api/admin/caos/servico", { acao, ...extra() });
    toast(mensagem(), "ok");
    await carregar();
  });
}

document.querySelector("#injetar-falha").addEventListener("click", acaoServico(
  "falha",
  () => ({ segundos: Number(document.querySelector("#falha-segundos").value) }),
  () => `Banco "fora do ar" por ${document.querySelector("#falha-segundos").value} s. Envie ordens para ver o breaker abrir.`
));
document.querySelector("#abrir-servico").addEventListener("click", acaoServico("abrir", () => ({}), () => "Breaker do serviço aberto por 10 s."));
document.querySelector("#fechar-servico").addEventListener("click", acaoServico("fechar", () => ({}), () => "Breaker do serviço fechado."));

document.querySelector("#alavancagem").addEventListener("input", (evento) => {
  document.querySelector("#alavancagem-saida").textContent = `${numeroBr(evento.target.value, 1)}×`;
});

document.querySelector("#form-alavancagem").addEventListener("submit", (evento) => {
  evento.preventDefault();
  comBotao(evento.submitter, "Redistribuindo crédito…", async () => {
    const resultado = await enviar("/api/admin/caos/alavancagem", { fator: Number(document.querySelector("#alavancagem").value) });
    document.querySelector("#alavancagem-contexto").textContent =
      `${resultado.agentes} agentes ajustados · ${reais(resultado.emprestadoCentavos)} emprestados · ${reais(resultado.quitadoCentavos)} quitados.`;
    toast(`Alavancagem em ${numeroBr(resultado.fator, 1)}×.`, "ok");
    await carregar();
  });
});

document.querySelector("#form-roleta").addEventListener("submit", (evento) => {
  evento.preventDefault();
  comBotao(evento.submitter, "Salvando…", async () => {
    const config = await enviar("/api/admin/caos/roleta", {
      ativa: document.querySelector("#roleta-ativa").checked,
      chanceGanhoPct: Number(document.querySelector("#roleta-ganho").value),
      chanceQuebraPct: Number(document.querySelector("#roleta-quebra").value),
    });
    toast(config.roleta.ativa ? "Roleta ligada. Acompanhe CAOS_GANHO e CAOS_QUEBRA na aba Logs." : "Roleta desligada.", "ok");
  });
});

document.querySelector("#forcar-ganho").addEventListener("click", (e) => comBotao(e.currentTarget, "Sorteando…", async () => {
  const resultado = await enviar("/api/admin/caos/agente/ganho");
  toast(`Robô #${resultado.usuarioId} recebeu ${reais(resultado.deltaCentavos)}.`, "ok");
}));

document.querySelector("#forcar-quebra").addEventListener("click", (e) => comBotao(e.currentTarget, "Quebrando…", async () => {
  const resultado = await enviar("/api/admin/caos/agente/quebra");
  toast(`Robô #${resultado.usuarioId} quebrou e está despejando a carteira no livro.`, "ok");
  await carregar();
}));

document.querySelector("#reanimar").addEventListener("click", (e) => comBotao(e.currentTarget, "Reanimando…", async () => {
  const { quantidade } = await enviar("/api/admin/caos/reanimar");
  toast(quantidade ? `${quantidade} agente(s) de volta ao mercado com o capital inicial.` : "Nenhum agente quebrado agora.", "ok");
}));

document.querySelector("#form-baleia").addEventListener("submit", (evento) => {
  evento.preventDefault();
  comBotao(evento.submitter, "Soltando…", async () => {
    const ticker = document.querySelector("#baleia-ticker").value;
    await enviar("/api/admin/caos/baleia", {
      ticker,
      capitalReais: Number(document.querySelector("#baleia-capital").value),
      alavancagem: Number(document.querySelector("#baleia-alavancagem").value),
      alvoParticipacaoPct: Number(document.querySelector("#baleia-participacao").value),
      alvoLucroPct: Number(document.querySelector("#baleia-lucro").value),
    });
    toast(`Baleia solta em ${ticker}. Ela começa acumulando já na próxima rodada.`, "ok");
    await carregar();
  });
});

carregar().catch((erro) => toast(erro.message, "erro"));
setInterval(() => carregar().catch(() => marcarAoVivo("Sem resposta do servidor", false)), 2000);
