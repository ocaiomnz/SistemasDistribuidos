const ROTULOS_PERFIL = {
  conservador: "Conservador",
  agressivo: "Agressivo",
  momentum: "Momentum",
  contrarian: "Contrarian",
  aleatorio: "Aleatório",
  formador: "Formador de mercado",
  humano: "Humanos",
  carga: "Contas de carga",
  baleia: "Baleias",
  agente: "Agentes sem perfil",
};

const GRUPOS = [
  ["positivo", "Boas notícias"],
  ["negativo", "Más notícias"],
  ["mercado", "Mercado inteiro"],
];

const estado = { dados: null, formularioPronto: false, configCarregada: false, confirmando: false };

function limitar(valor, minimo, maximo) {
  return Math.min(maximo, Math.max(minimo, valor));
}

function humor(confianca) {
  if (confianca >= 10) return "Otimista";
  if (confianca <= -10) return "Pessimista";
  return "Neutra";
}

function medidor(confianca) {
  const largura = Math.min(50, Math.abs(confianca) / 2);
  const lado = confianca >= 0 ? `left: 50%; width: ${largura}%` : `left: ${50 - largura}%; width: ${largura}%`;
  return el("div", { classe: "medidor", role: "img", "aria-label": `Confiança ${Math.round(confianca)} numa escala de −100 a 100` },
    el("span", { classe: confianca >= 0 ? "alta" : "baixa", style: lado }),
    el("i"));
}

function modeloAtual() {
  const id = document.querySelector("#noticia-modelo").value;
  return estado.dados?.modelos.find((modelo) => modelo.id === id) || null;
}

function descreverEfeito() {
  const dados = estado.dados;
  if (!dados) return;
  const ticker = document.querySelector("#noticia-ticker").value;
  const impacto = Number(document.querySelector("#noticia-impacto").value);
  const alvo = document.querySelector("#noticia-efeito");
  const choque = impacto * dados.choquePorPonto;
  if (impacto === 0) {
    alvo.textContent = "0%: escolha uma intensidade diferente de zero.";
    return;
  }
  if (!ticker) {
    alvo.textContent = `${pct(impacto, 0)} no valor justo das ${dados.ativos.length} ações e ${choque > 0 ? "+" : ""}${choque} pontos de confiança em cada uma.`;
    return;
  }
  const ativo = dados.ativos.find((item) => item.ticker === ticker);
  const depois = Math.round(ativo.fundamentoCentavos * (1 + impacto / 100));
  const confianca = limitar(ativo.confianca + choque, -100, 100);
  alvo.textContent = `${pct(impacto, 0)} no valor justo de ${ticker}: ${reais(ativo.fundamentoCentavos)} → ${reais(depois)}. Confiança dos robôs: ${Math.round(ativo.confianca)} → ${Math.round(confianca)}.`;
}

function aplicarModelo() {
  const modelo = modeloAtual();
  if (!modelo) {
    document.querySelector("#noticia-titulo").value = "";
    document.querySelector("#noticia-titulo").focus();
    descreverEfeito();
    return;
  }
  document.querySelector("#noticia-titulo").value = modelo.titulo;
  document.querySelector("#noticia-impacto").value = modelo.impactoPct;
  if (modelo.grupo === "mercado") document.querySelector("#noticia-ticker").value = "";
  else if (!document.querySelector("#noticia-ticker").value) document.querySelector("#noticia-ticker").selectedIndex = 1;
  descreverEfeito();
}

function prepararFormulario(dados) {
  if (estado.formularioPronto) return;
  document.querySelector("#noticia-ticker").replaceChildren(
    el("option", { value: "", texto: "Mercado inteiro (todas as ações)" }),
    ...dados.ativos.map((ativo) => el("option", { value: ativo.ticker, texto: `${ativo.ticker} · ${ativo.nome}` })));
  document.querySelector("#noticia-ticker").selectedIndex = 1;
  document.querySelector("#noticia-modelo").replaceChildren(
    ...GRUPOS.map(([grupo, rotulo]) => el("optgroup", { label: rotulo },
      dados.modelos.filter((modelo) => modelo.grupo === grupo).map((modelo) =>
        el("option", { value: modelo.id, texto: `${modelo.titulo} (${pct(modelo.impactoPct, 0)})` })))),
    el("option", { value: "", texto: "Escrever a minha manchete" }));
  aplicarModelo();
  estado.formularioPronto = true;
}

function desenharConfianca(ativos) {
  document.querySelector("#confianca-ativos").replaceChildren(...ativos.map((ativo) => {
    const desvio = ((ativo.precoCentavos - ativo.fundamentoCentavos) / ativo.fundamentoCentavos) * 100;
    const leitura = Math.abs(desvio) < 2 ? "no preço" : desvio > 0 ? "caro" : "barato";
    const noticia = ativo.ultimaNoticia;
    return el("tr", { classe: ativo.suspensao ? "suspenso" : "" },
      el("td", {}, el("strong", { texto: ativo.ticker }), el("p", { classe: "legenda", texto: ativo.suspensao ? `Suspenso até ${hora(ativo.suspensao.ate)}` : ativo.nome })),
      el("td", { classe: "num", texto: reais(ativo.precoCentavos) }),
      el("td", { classe: "num" }, reais(ativo.fundamentoCentavos), el("p", { classe: "legenda", texto: `robôs enxergam ${reais(ativo.percebidoCentavos)}` })),
      el("td", { classe: `num${Math.abs(desvio) >= 15 ? " alerta-texto" : ""}`, texto: `${pct(desvio)} · ${leitura}` }),
      el("td", { classe: "celula-medidor" }, medidor(ativo.confianca),
        el("p", { classe: "legenda", texto: `${humor(ativo.confianca)} · ${Math.round(ativo.confianca)}` })),
      el("td", {}, noticia
        ? el("span", {}, el("span", { classe: noticia.impactoPct > 0 ? "positivo" : "negativo", texto: `${pct(noticia.impactoPct)} ` }), noticia.titulo,
          el("p", { classe: "legenda", texto: hora(noticia.em) }))
        : el("span", { classe: "legenda", texto: "Sem notícia nesta sessão" })),
      el("td", {}, grafico(ativo.historico.map((item) => item.precoCentavos), { largura: 140, altura: 32 })));
  }));
  const { pesoConfiancaPct, config } = estado.dados;
  document.querySelector("#confianca-legenda").textContent =
    `Os robôs compram abaixo do valor que enxergam e vendem acima. Confiança +100 faz pagarem até ${pesoConfiancaPct}% acima do valor justo; −100, ${pesoConfiancaPct}% abaixo. A confiança cai pela metade a cada ${config.meiaVidaS} s.`;
}

function bloco(rotulo, valor, contexto, { serie, alerta, classe } = {}) {
  return el("div", { classe: `bloco-metrica${alerta ? " atencao" : ""}` },
    el("p", { classe: "rotulo", texto: rotulo }),
    el("p", { classe: `valor ${classe || ""}`.trim(), texto: valor }),
    serie && serie.length > 1 ? grafico(serie) : null,
    el("p", { classe: "contexto", texto: contexto }));
}

function sinal(valor) {
  return valor > 0 ? "positivo" : valor < 0 ? "negativo" : "";
}

function desenharResultado(resultado, amostras) {
  const serie = (campo) => amostras.map((item) => item[campo]);
  const { estrutura } = resultado;
  const desequilibrado = resultado.contas > 5 && resultado.perdendo === 0;
  document.querySelector("#resultado-blocos").replaceChildren(
    bloco("Contas ganhando", numeroBr(resultado.ganhando), `de ${resultado.contas} em jogo · somam ${reais(resultado.ganhosCentavos)}`, { serie: serie("ganhando") }),
    bloco("Contas perdendo", numeroBr(resultado.perdendo), desequilibrado
      ? "Ninguém perde: sinal de mercado desequilibrado."
      : `somam ${reais(resultado.perdasCentavos)}`, { serie: serie("perdendo"), alerta: desequilibrado }),
    bloco("Resultado líquido", reais(resultado.liquidoCentavos), `retorno médio ${pct(resultado.retornoMedioPct, 2)} sobre o capital`, { serie: serie("liquidoCentavos"), classe: sinal(resultado.liquidoCentavos) }),
    bloco("Comprar e segurar", pct(estrutura.indiceDesdeAberturaPct, 2), "variação de todas as ações desde a abertura do pregão", { serie: serie("indicePct"), classe: sinal(estrutura.indiceDesdeAberturaPct) }),
    bloco("Caixa ÷ ações", `${numeroBr(estrutura.caixaPorAcoes, 1)}×`, estrutura.caixaPorAcoes > 3
      ? `Excesso de caixa: ${reais(estrutura.caixaCentavos)} correndo atrás de ${reais(estrutura.valorEmAcoesCentavos)} em ações. Comprador sobra e o preço sobe.`
      : `${reais(estrutura.caixaCentavos)} em caixa para ${reais(estrutura.valorEmAcoesCentavos)} em ações.`, { alerta: estrutura.caixaPorAcoes > 3 }),
    bloco("Preço vs. valor justo", pct(estrutura.premioSobreValorJustoPct), Math.abs(estrutura.premioSobreValorJustoPct) > 20
      ? "O mercado está longe do valor justo; a correção pesa em quem comprou caro."
      : "Quanto o conjunto das ações está acima ou abaixo do valor justo.", { alerta: Math.abs(estrutura.premioSobreValorJustoPct) > 20 }));

  const perfis = Object.entries(resultado.porPerfil).sort((a, b) => b[1].retornoPct - a[1].retornoPct);
  document.querySelector("#resultado-perfis").replaceChildren(...(perfis.length ? perfis.map(([perfil, grupo]) => el("tr", {},
    el("td", { texto: ROTULOS_PERFIL[perfil] || perfil }),
    el("td", { classe: "num", texto: numeroBr(grupo.contas) }),
    el("td", { classe: "num positivo", texto: numeroBr(grupo.ganhando) }),
    el("td", { classe: "num negativo", texto: numeroBr(grupo.perdendo) }),
    el("td", { classe: `num ${sinal(grupo.lucroCentavos)}`, texto: reais(grupo.lucroCentavos) }),
    el("td", { classe: `num ${sinal(grupo.retornoPct)}`, texto: pct(grupo.retornoPct, 2) }))) : [linhaVazia(6, "Nenhuma conta ainda.", "Crie robôs na aba Admin.")]));

  const linhaConta = (conta) => el("tr", {},
    el("td", {}, conta.nome, el("p", { classe: "legenda", texto: `${ROTULOS_PERFIL[conta.perfil] || conta.perfil}${conta.estado !== "ativo" ? ` · ${conta.estado}` : ""}` })),
    el("td", { classe: `num ${sinal(conta.lucroCentavos)}` }, reais(conta.lucroCentavos), el("p", { classe: "legenda", texto: pct(conta.retornoPct, 1) })));
  document.querySelector("#resultado-melhores").replaceChildren(...resultado.melhores.map(linhaConta));
  document.querySelector("#resultado-piores").replaceChildren(...resultado.piores.map(linhaConta));
}

function desenharNoticias(noticias) {
  const corpo = document.querySelector("#noticias");
  if (noticias.length === 0) {
    corpo.replaceChildren(linhaVazia(4, "Nenhuma notícia ainda.", "Publique a primeira ao lado ou ligue as notícias automáticas."));
    return;
  }
  corpo.replaceChildren(...noticias.map((noticia) => el("tr", {},
    el("td", { texto: hora(noticia.em) }),
    el("td", { texto: noticia.ticker || "Mercado" }),
    el("td", {}, noticia.titulo, el("p", { classe: "legenda", texto: noticia.origem === "admin" ? "publicada pelo ADMIN" : "sorteada pelo mundo" })),
    el("td", { classe: `num ${sinal(noticia.impactoPct)}`, texto: pct(noticia.impactoPct) }))));
}

function desenharAutomaticas(config) {
  if (!estado.configCarregada) {
    document.querySelector("#auto-ligadas").checked = config.automaticas;
    document.querySelector("#auto-intervalo").value = config.intervaloS;
    document.querySelector("#auto-meia-vida").value = config.meiaVidaS;
    estado.configCarregada = true;
  }
  document.querySelector("#auto-contexto").textContent = config.automaticas && config.proximaAutomatica
    ? `Ligadas. Próxima notícia por volta de ${hora(config.proximaAutomatica)}.`
    : "Desligadas. Só o ADMIN publica.";
}

function desenharRodada() {
  const alvo = document.querySelector("#rodada-acoes");
  if (!estado.confirmando) {
    alvo.replaceChildren(el("button", { type: "button", classe: "perigo", texto: "Recomeçar rodada", onclick: () => {
      estado.confirmando = true;
      desenharRodada();
    } }));
    return;
  }
  alvo.replaceChildren(
    el("p", { classe: "legenda", texto: "Recomeçar agora? Todas as ordens abertas serão canceladas e o resultado dos robôs volta a zero." }),
    el("button", { type: "button", classe: "perigo", texto: "Confirmar recomeço", onclick: (e) => comBotao(e.currentTarget, "Recomeçando…", async () => {
      const resumo = await enviar("/api/admin/mundo/recomecar");
      estado.confirmando = false;
      desenharRodada();
      toast(`Rodada recomeçada: ${resumo.ordensCanceladas} ordens canceladas, ${resumo.contasReequilibradas} contas reequilibradas.`, "ok");
      await carregar();
    }) }),
    el("button", { type: "button", classe: "secundario", texto: "Voltar", onclick: () => {
      estado.confirmando = false;
      desenharRodada();
    } }));
}

async function carregar() {
  const dados = await pegar("/api/admin/mundo");
  estado.dados = dados;
  prepararFormulario(dados);
  desenharConfianca(dados.ativos);
  desenharResultado(dados.resultado, dados.amostras);
  desenharNoticias(dados.noticias);
  desenharAutomaticas(dados.config);
  descreverEfeito();
  marcarAoVivo(`Atualizado às ${hora(new Date())}`);
}

document.querySelector("#noticia-modelo").addEventListener("change", aplicarModelo);
document.querySelector("#noticia-ticker").addEventListener("change", descreverEfeito);
document.querySelector("#noticia-impacto").addEventListener("input", descreverEfeito);

document.querySelector("#form-noticia").addEventListener("submit", (evento) => {
  evento.preventDefault();
  comBotao(evento.submitter, "Publicando…", async () => {
    const noticia = await enviar("/api/admin/mundo/noticia", {
      ticker: document.querySelector("#noticia-ticker").value || null,
      titulo: document.querySelector("#noticia-titulo").value,
      impactoPct: Number(document.querySelector("#noticia-impacto").value),
    });
    toast(`Notícia publicada em ${noticia.ticker || "todo o mercado"}. Os robôs reagem já na próxima rodada.`, "ok");
    await carregar();
  });
});

document.querySelector("#form-automaticas").addEventListener("submit", (evento) => {
  evento.preventDefault();
  comBotao(evento.submitter, "Salvando…", async () => {
    const config = await enviar("/api/admin/mundo/config", {
      automaticas: document.querySelector("#auto-ligadas").checked,
      intervaloS: Number(document.querySelector("#auto-intervalo").value),
      meiaVidaS: Number(document.querySelector("#auto-meia-vida").value),
    });
    toast(config.automaticas ? `Notícias automáticas a cada ${config.intervaloS} s, em média.` : "Notícias automáticas desligadas.", "ok");
    await carregar();
  });
});

desenharRodada();
carregar().catch((erro) => toast(erro.message, "erro"));
setInterval(() => carregar().catch(() => marcarAoVivo("Sem resposta do servidor", false)), 2500);
