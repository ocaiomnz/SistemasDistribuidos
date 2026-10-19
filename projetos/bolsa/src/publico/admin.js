const estado = { configCarregada: false, confirmandoEncerrar: false, cargaRodando: false };

function desenharPerfis(perfis) {
  const grupo = document.querySelector("#robos-perfis");
  if (grupo.querySelector("input")) return;
  for (const [id, perfil] of Object.entries(perfis)) {
    grupo.append(el("label", { classe: "caixa", title: perfil.descricao },
      el("input", { type: "checkbox", name: "perfil", value: id, checked: true }),
      el("span", {}, el("strong", { texto: perfil.rotulo }), el("span", { classe: "legenda", texto: ` ${perfil.descricao}` }))));
  }
}

function desenharAgentes(agentes, perfis) {
  document.querySelector("#agentes-ativos").textContent = `${numeroBr(agentes.ativos)} agentes ativos`;
  document.querySelector("#agentes-contexto").textContent = agentes.ligados
    ? `${agentes.porRodada} agem a cada ${numeroBr(agentes.intervaloMs)} ms · ${numeroBr(agentes.rodadas)} rodadas desde o início`
    : "Agentes pausados. Nenhuma ordem automática está sendo enviada.";
  const linhas = Object.entries(agentes.porPerfil).map(([perfil, estados]) => el("tr", {},
    el("td", { texto: perfis[perfil]?.rotulo || (perfil === "baleia" ? "Baleia" : perfil) }),
    el("td", { classe: "num", texto: estados.ativo || 0 }),
    el("td", { classe: "num", texto: estados.quebrado || 0 }),
    el("td", { classe: "num", texto: (estados.saiu || 0) + (estados.encerrado || 0) })));
  document.querySelector("#agentes-perfis").replaceChildren(...(linhas.length ? linhas : [linhaVazia(4, "Nenhum agente.", "Crie perfis ao lado.")]));
  if (!estado.configCarregada) {
    document.querySelector("#ritmo-ligados").checked = agentes.ligados;
    document.querySelector("#ritmo-intervalo").value = agentes.intervaloMs;
    document.querySelector("#ritmo-rodada").value = agentes.porRodada;
  }
}

function desenharCarga(carga, historico) {
  const texto = document.querySelector("#carga-estado");
  const botao = document.querySelector("#disparar-carga");
  if (carga) {
    texto.textContent = `Rodando: ${carga.usuarios} usuários × ${carga.ordensPorUsuario} ordens · etapa "${carga.fase}" desde ${hora(carga.inicio)}.`;
    botao.disabled = true;
    botao.textContent = "Teste em andamento…";
  } else {
    if (estado.cargaRodando && historico[0]) {
      const ultimo = historico[0];
      toast(`Carga concluída: ${ultimo.aceitas} de ${ultimo.enviadas} ordens aceitas, ${numeroBr(ultimo.ordensPorSegundo, 1)} ordens/s, p95 ${ultimo.latenciaP95Ms} ms.`, "ok");
    }
    texto.textContent = historico[0]
      ? `Último teste às ${hora(historico[0].criadoEm)}. Rejeições por saldo ou ações também contam como resposta válida do servidor.`
      : "Nenhum teste rodou ainda. Escolha um cenário e dispare.";
    botao.disabled = false;
    botao.textContent = "Disparar teste";
  }
  estado.cargaRodando = Boolean(carga);
  document.querySelector("#carga-historico").replaceChildren(...(historico.length
    ? historico.map((item) => el("tr", {},
      el("td", { texto: hora(item.criadoEm) }),
      el("td", { classe: "num", texto: item.usuarios }),
      el("td", { classe: "num", texto: item.enviadas }),
      el("td", { classe: "num", texto: item.aceitas }),
      el("td", { classe: "num", texto: numeroBr(item.ordensPorSegundo, 1) }),
      el("td", { classe: "num", texto: `${item.latenciaMediaMs} ms` }),
      el("td", { classe: "num", texto: `${item.latenciaP95Ms} ms` }),
      el("td", { classe: "num", texto: `${item.latenciaMaxMs} ms` }),
      el("td", { classe: "num", texto: `${numeroBr(item.cpuPct, 1)}%` })))
    : [linhaVazia(9, "Sem histórico de carga.", "O resultado de cada teste aparece aqui.")]));
}

function desenharRanking(ranking, perfis) {
  document.querySelector("#ranking").replaceChildren(...ranking.map((item, indice) => el("tr", {},
    el("td", { classe: "num", texto: indice + 1 }),
    el("td", { texto: item.nome }),
    el("td", { texto: perfis[item.perfil]?.rotulo || item.perfil }),
    el("td", { classe: item.estado === "ativo" ? "" : "negativo", texto: item.estado }),
    el("td", { classe: "num", texto: reais(item.patrimonioCentavos) }),
    el("td", { classe: "num", texto: item.dividaCentavos ? reais(item.dividaCentavos) : "—" }),
    el("td", { classe: `num ${item.lucroCentavos > 0 ? "positivo" : item.lucroCentavos < 0 ? "negativo" : ""}`, texto: reais(item.lucroCentavos) }))));
}

async function carregar() {
  const painel = await pegar("/api/admin/painel");
  desenharPerfis(painel.perfis);
  desenharAgentes(painel.agentes, painel.perfis);
  desenharCarga(painel.carga, painel.historicoCarga);
  desenharRanking(painel.ranking, painel.perfis);
  estado.configCarregada = true;
  marcarAoVivo(`Atualizado às ${hora(new Date())}`);
}

function atualizarRotuloRobos() {
  const quantidade = Number(document.querySelector("#robos-quantidade").value) || 0;
  document.querySelector("#criar-robos").textContent = `Criar ${quantidade} perfis`;
}

document.querySelector("#robos-quantidade").addEventListener("input", atualizarRotuloRobos);

document.querySelector("#form-robos").addEventListener("submit", (evento) => {
  evento.preventDefault();
  const perfis = [...document.querySelectorAll("input[name=perfil]:checked")].map((caixa) => caixa.value);
  if (perfis.length === 0) {
    toast("Marque ao menos uma estratégia para o sorteio.", "erro");
    return;
  }
  comBotao(document.querySelector("#criar-robos"), "Criando perfis…", async () => {
    const resultado = await enviar("/api/admin/robos", {
      quantidade: Number(document.querySelector("#robos-quantidade").value),
      perfis,
      capitalMinReais: Number(document.querySelector("#robos-min").value),
      capitalMaxReais: Number(document.querySelector("#robos-max").value),
    });
    const mistura = Object.entries(resultado.perfis).map(([perfil, n]) => `${n} ${perfil}`).join(", ");
    toast(`${resultado.quantidade} perfis no mercado: ${mistura}.`, "ok");
    await carregar();
  }).finally(atualizarRotuloRobos);
});

document.querySelector("#encerrar-robos").addEventListener("click", (evento) => {
  const botao = evento.currentTarget;
  if (!estado.confirmandoEncerrar) {
    estado.confirmandoEncerrar = true;
    botao.textContent = "Confirmar: encerrar todos os robôs";
    document.querySelector("#encerrar-ajuda").textContent = "Clique de novo em até 5 s para confirmar. As ordens abertas dos robôs serão canceladas.";
    setTimeout(() => {
      estado.confirmandoEncerrar = false;
      botao.textContent = "Encerrar todos os robôs";
      document.querySelector("#encerrar-ajuda").textContent = "Cancela as ordens abertas dos robôs e tira todos do mercado. Ana e Bruno continuam.";
    }, 5000);
    return;
  }
  estado.confirmandoEncerrar = false;
  comBotao(botao, "Encerrando…", async () => {
    const resultado = await enviar("/api/admin/robos/encerrar");
    toast(`${resultado.quantidade} robôs encerrados · ${resultado.ordensCanceladas} ordens canceladas.`, "ok");
    await carregar();
  }).finally(() => {
    botao.textContent = "Encerrar todos os robôs";
  });
});

document.querySelector("#form-ritmo").addEventListener("submit", (evento) => {
  evento.preventDefault();
  comBotao(evento.submitter, "Salvando…", async () => {
    await enviar("/api/admin/agentes/ritmo", {
      ligados: document.querySelector("#ritmo-ligados").checked,
      intervaloMs: Number(document.querySelector("#ritmo-intervalo").value),
      porRodada: Number(document.querySelector("#ritmo-rodada").value),
    });
    toast("Ritmo dos agentes salvo.", "ok");
    await carregar();
  });
});

for (const preset of document.querySelectorAll("#carga-presets button")) {
  preset.addEventListener("click", () => {
    document.querySelector("#carga-usuarios").value = preset.dataset.usuarios;
    document.querySelector("#carga-ordens").value = preset.dataset.ordens;
  });
}

document.querySelector("#form-carga").addEventListener("submit", (evento) => {
  evento.preventDefault();
  comBotao(document.querySelector("#disparar-carga"), "Disparando…", async () => {
    await enviar("/api/admin/carga", {
      usuarios: Number(document.querySelector("#carga-usuarios").value),
      ordensPorUsuario: Number(document.querySelector("#carga-ordens").value),
    });
    toast("Teste de carga iniciado. Acompanhe a latência na aba Logs.", "ok");
  }).then(() => carregar());
});

const campoFlush = document.querySelector("#flush-confirmacao");
campoFlush.addEventListener("input", () => {
  document.querySelector("#flush-botao").disabled = campoFlush.value !== "FLUSH";
});

document.querySelector("#form-flush").addEventListener("submit", (evento) => {
  evento.preventDefault();
  if (campoFlush.value !== "FLUSH") return;
  const botao = document.querySelector("#flush-botao");
  comBotao(botao, "Zerando…", async () => {
    const resumo = await enviar("/api/admin/mercado/flush", {
      confirmacao: campoFlush.value,
      apagarHumanos: document.querySelector("#flush-humanos").checked,
    });
    const { apagados } = resumo;
    document.querySelector("#flush-resultado").textContent =
      `Apagados: ${numeroBr(apagados.ordens)} ordens, ${numeroBr(apagados.negociacoes)} negócios, ${numeroBr(apagados.eventos)} eventos, ${numeroBr(apagados.noticias)} notícias e ${numeroBr(resumo.contasApagadas)} contas. ${numeroBr(resumo.contasMantidas)} conta(s) mantida(s) com ${reais(resumo.capitalPorContaCentavos)} em caixa.`;
    toast("Mercado zerado. Ana e Bruno voltaram com carteira nova; crie robôs para movimentar o pregão.", "ok");
    campoFlush.value = "";
    document.querySelector("#flush-humanos").checked = false;
    estado.configCarregada = false;
    await carregar();
  }).finally(() => {
    botao.disabled = campoFlush.value !== "FLUSH";
  });
});

carregar().catch((erro) => toast(erro.message, "erro"));
setInterval(() => carregar().catch(() => marcarAoVivo("Sem resposta do servidor", false)), 2500);
