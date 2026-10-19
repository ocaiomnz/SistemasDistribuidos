const ETAPAS = [
  ["ORDER_RECEIVED", "Ordem recebida", "O servidor aceitou a mensagem e entrou na fila."],
  ["ORDER_VALIDATED", "Ordem validada", "Saldo ou ações reservados na mesma transação."],
  ["ORDER_BOOK_INSERTED", "Inserida no livro", "Gravada com prioridade preço-tempo."],
  ["MATCH_FOUND", "Contraparte encontrada", "Ordem oposta compatível achada no livro."],
  ["TRADE_EXECUTED", "Negócio executado", "Preço do negócio é o da ordem que já estava no livro."],
  ["PORTFOLIO_UPDATED", "Carteiras atualizadas", "Saldo e posições de comprador e vendedor."],
  ["CLIENTS_NOTIFIED", "Clientes notificados", "Evento SSE enviado após o commit."],
];

const CAMPOS_FIXOS = new Set(["ts", "seq", "nivel", "categoria", "evento"]);
const MAX_LINHAS = 250;

const estado = {
  entradas: [],
  ultimoHash: null,
  ultimoSeq: 0,
  verificados: 0,
  quebras: [],
  pausado: false,
  pendentesDesenho: false,
  historico: [],
  ordemRastreada: null,
  servidor: null,
};

let filaHash = Promise.resolve();

async function sha256(texto) {
  const bytes = new TextEncoder().encode(texto);
  const resumo = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(resumo)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function verificarEntrada(entrada) {
  filaHash = filaHash.then(async () => {
    if (entrada.seq <= estado.ultimoSeq) return;
    const calculado = await sha256(`${entrada.anterior}|${entrada.corpo}`);
    const consecutivo = estado.ultimoHash !== null && entrada.seq === estado.ultimoSeq + 1;
    const elo = !consecutivo || entrada.anterior === estado.ultimoHash;
    entrada.valido = calculado === entrada.hash && elo;
    entrada.dados = JSON.parse(entrada.corpo);
    if (!entrada.valido) estado.quebras.push(entrada.seq);
    estado.ultimoHash = entrada.hash;
    estado.ultimoSeq = entrada.seq;
    estado.verificados += 1;
    estado.entradas.push(entrada);
    if (estado.entradas.length > 2000) estado.entradas.shift();
    agendarDesenho();
  });
  return filaHash;
}

function agendarDesenho() {
  if (estado.pendentesDesenho || estado.pausado) return;
  estado.pendentesDesenho = true;
  setTimeout(() => {
    estado.pendentesDesenho = false;
    desenharLogs();
    desenharCadeia();
  }, 250);
}

function resumoDe(dados) {
  return Object.entries(dados)
    .filter(([chave]) => !CAMPOS_FIXOS.has(chave))
    .map(([chave, valor]) => `${chave}=${typeof valor === "object" ? JSON.stringify(valor) : valor}`)
    .join(" · ");
}

function passaFiltro(entrada) {
  const categoria = document.querySelector("#filtro-categoria").value;
  const nivel = document.querySelector("#filtro-nivel").value;
  const texto = document.querySelector("#filtro-texto").value.trim().toLowerCase();
  if (categoria && entrada.dados.categoria !== categoria) return false;
  if (nivel && entrada.dados.nivel !== nivel) return false;
  if (texto && !`${entrada.dados.evento} ${resumoDe(entrada.dados)}`.toLowerCase().includes(texto)) return false;
  return true;
}

function desenharLogs() {
  const corpo = document.querySelector("#logs");
  const visiveis = [];
  for (let i = estado.entradas.length - 1; i >= 0 && visiveis.length < MAX_LINHAS; i -= 1) {
    if (passaFiltro(estado.entradas[i])) visiveis.push(estado.entradas[i]);
  }
  if (visiveis.length === 0) {
    corpo.replaceChildren(linhaVazia(6, "Nenhum registro com esses filtros.", "Limpe a busca ou escolha outra categoria."));
    return;
  }
  corpo.replaceChildren(...visiveis.map((entrada) => {
    const { dados } = entrada;
    const ordemId = dados.ordemId || dados.contraOrdemId;
    const detalhe = el("td", { classe: "detalhe" }, resumoDe(dados));
    if (dados.evento === "ORDER_RECEIVED") {
      detalhe.prepend(el("button", {
        type: "button",
        classe: "texto mini",
        texto: `Rastrear #${ordemId}`,
        onclick: () => rastrear(dados.ordemId),
      }), " ");
    }
    return el("tr", { classe: `nivel-${dados.nivel}${entrada.valido ? "" : " quebrado"}` },
      el("td", { classe: "num", texto: entrada.seq }),
      el("td", { texto: hora(dados.ts) }),
      el("td", {}, el("span", { classe: `selo ${dados.nivel}`, texto: dados.nivel })),
      el("td", { classe: "evento", texto: dados.evento }),
      detalhe,
      el("td", { classe: entrada.valido ? "hash positivo" : "hash negativo", title: entrada.hash },
        `${entrada.hash.slice(0, 8)} ${entrada.valido ? "válido" : "inválido"}`),
    );
  }));
}

function desenharCadeia() {
  const titulo = document.querySelector("#cadeia-estado");
  const contexto = document.querySelector("#cadeia-contexto");
  const integra = estado.quebras.length === 0 && (!estado.servidor || estado.servidor.integra);
  titulo.textContent = integra ? "Íntegra" : "Adulteração detectada";
  titulo.className = `display ${integra ? "positivo" : "negativo"}`;
  if (integra) {
    contexto.textContent = "Todo registro recebido bate com o hash e aponta para o anterior. Qualquer edição quebraria a corrente.";
  } else {
    const ondeServidor = estado.servidor && !estado.servidor.integra
      ? `O servidor achou: ${estado.servidor.motivo} no registro #${estado.servidor.quebraEm}.`
      : "";
    const ondeNavegador = estado.quebras.length ? `O navegador marcou ${estado.quebras.length} registro(s) inválido(s): #${estado.quebras.slice(-3).join(", #")}.` : "";
    contexto.textContent = `${ondeServidor} ${ondeNavegador}`.trim();
  }
  const detalhes = [
    ["Verificados no navegador", numeroBr(estado.verificados)],
    ["Último hash", estado.ultimoHash ? `${estado.ultimoHash.slice(0, 16)}…` : "—"],
    ["Servidor", estado.servidor ? `${numeroBr(estado.servidor.verificados)} registros às ${hora(estado.servidor.em)}` : "—"],
    ["Algoritmo", "SHA-256 encadeado"],
  ];
  document.querySelector("#cadeia-detalhes").replaceChildren(...detalhes.map(([rotulo, valor]) =>
    el("div", {}, el("dt", { texto: rotulo }), el("dd", { texto: valor }))));
}

async function carregarRecentes() {
  const { entradas, cadeia } = await pegar("/api/admin/logs/recentes?limite=400");
  filaHash = filaHash.then(() => {
    estado.entradas = [];
    estado.ultimoHash = null;
    estado.ultimoSeq = 0;
    estado.verificados = 0;
    estado.quebras = [];
    estado.servidor = { ...cadeia, em: new Date().toISOString() };
  });
  for (const entrada of entradas) verificarEntrada(entrada);
  await filaHash;
  desenharLogs();
  desenharCadeia();
}

function bloco(rotulo, valor, contexto, { serie, alerta } = {}) {
  return el("div", { classe: `bloco-metrica${alerta ? " atencao" : ""}` },
    el("p", { classe: "rotulo", texto: rotulo }),
    el("p", { classe: "valor", texto: valor }),
    serie ? grafico(serie) : null,
    el("p", { classe: "contexto", texto: contexto }));
}

function desenharMonitor(atual) {
  if (!atual) return;
  const serie = (campo) => estado.historico.map((item) => item[campo] ?? 0);
  const c = atual.contadores;
  const servico = atual.protecoes?.servico || {};
  const mercado = atual.protecoes?.mercado || {};
  const suspensos = (mercado.ativos || []).length + (mercado.suspensoAte ? 1 : 0);
  document.querySelector("#monitor").replaceChildren(
    bloco("Ordens por segundo", numeroBr(atual.ordensPorSegundo, 1), `${numeroBr(c.ordensAceitas)} aceitas · ${numeroBr(c.ordensRejeitadas)} rejeitadas`, { serie: serie("ordensPorSegundo") }),
    bloco("Negócios por segundo", numeroBr(atual.negociosPorSegundo, 1), `${numeroBr(c.negocios)} negócios desde o início`, { serie: serie("negociosPorSegundo") }),
    bloco("Latência da ordem", `${numeroBr(atual.latenciaMediaMs, 1)} ms`, `p95 ${numeroBr(atual.latenciaP95Ms, 1)} ms, da chegada à notificação`, { serie: serie("latenciaMediaMs"), alerta: atual.latenciaP95Ms > 500 }),
    bloco("CPU do processo", `${numeroBr(atual.cpuPct, 1)}%`, `${numeroBr(atual.memoriaMb, 1)} MB de memória · heap ${numeroBr(atual.heapMb, 1)} MB`, { serie: serie("cpuPct"), alerta: atual.cpuPct > 80 }),
    bloco("Atraso do event loop", `${numeroBr(atual.atrasoLoopMs, 1)} ms`, "Acima de 50 ms o servidor está engasgando.", { alerta: atual.atrasoLoopMs > 50 }),
    bloco("MySQL", atual.mysql?.ok ? `${numeroBr(atual.mysql.pingMs, 1)} ms` : "Fora do ar", atual.mysql?.ok ? "Ping do pool de conexões" : atual.mysql?.erro || "Sem resposta", { alerta: !atual.mysql?.ok }),
    bloco("Fila do motor", numeroBr(atual.fila?.pendentes ?? 0), "Ordens aguardando a vez na fila única", { alerta: (atual.fila?.pendentes ?? 0) > 20 }),
    bloco("Clientes conectados", numeroBr(atual.sse?.clientes ?? 0), `${numeroBr(atual.logs.assinantes)} painel(is) de log abertos`),
    bloco("Breaker do serviço", servico.estado || "—", `${servico.falhas ?? 0} de ${servico.limiteFalhas ?? 3} falhas para abrir`, { alerta: servico.estado && servico.estado !== "fechado" }),
    bloco("Breaker do mercado", suspensos ? `${suspensos} suspensão(ões)` : "Negociando", mercado.automatico ? `Automático em ±${mercado.limitePct}%` : "Automático desligado", { alerta: suspensos > 0 }),
    bloco("Agentes", numeroBr(atual.agentes?.ativos ?? 0), atual.agentes?.ligados ? `${atual.agentes.porRodada} por rodada a cada ${atual.agentes.intervaloMs} ms` : "Pausados pelo ADMIN"),
    bloco("Erros registrados", numeroBr(c.erros), `${numeroBr(c.errosInfra)} de infraestrutura · ${numeroBr(c.eventosSeguranca)} eventos de segurança`, { alerta: c.erros > 0 }),
  );
}

function formatarMs(inicio, fim) {
  const delta = new Date(fim) - new Date(inicio);
  return `+${numeroBr(delta)} ms`;
}

function explicarAusencia(tipo, ordem) {
  if (tipo === "MATCH_FOUND" || tipo === "TRADE_EXECUTED" || tipo === "PORTFOLIO_UPDATED") {
    return ordem.status === "cancelada" ? "Cancelada antes de cruzar." : "Ainda sem contraparte; a ordem segue no livro.";
  }
  return "Não registrado.";
}

function desenharTrilha({ ordem, eventos }) {
  const alvo = document.querySelector("#trilha");
  const inicio = eventos.find((evento) => evento.tipo === "ORDER_RECEIVED")?.em;
  const etapas = ETAPAS.map(([tipo, rotulo, ajuda]) => {
    const doTipo = eventos.filter((item) => item.tipo === tipo);
    const evento = tipo === "CLIENTS_NOTIFIED" ? doTipo.at(-1) : doTipo[0];
    return el("li", { classe: evento ? "feito" : "pendente" },
      el("p", { classe: "etapa-nome" },
        el("strong", { texto: rotulo }), " ",
        el("span", { classe: "evento", texto: tipo }),
        doTipo.length > 1 ? el("span", { classe: "legenda", texto: ` · ${doTipo.length} vezes` }) : null),
      el("p", { classe: "legenda", texto: evento
        ? `${hora(evento.em)}.${String(new Date(evento.em).getMilliseconds()).padStart(3, "0")} · ${inicio ? formatarMs(inicio, evento.em) : ""}${evento.papel === "contraparte" ? " · disparado pela ordem #" + evento.ordemId : ""}`
        : explicarAusencia(tipo, ordem) }),
      el("p", { classe: "legenda", texto: evento ? ajuda : "" }));
  });
  const cabeca = el("div", { classe: "trilha-cabeca" },
    el("p", { classe: "rotulo", texto: `Ordem #${ordem.id} · ${ordem.agente ? "agente" : "investidor"} ${ordem.investidor}` }),
    el("p", { classe: "valor", texto: `${ordem.lado === "compra" ? "Compra" : "Venda"} de ${ordem.quantidade} ${ordem.ticker} a ${reais(ordem.precoCentavos)}` }),
    el("p", { classe: "contexto", texto: `Status ${ordem.status} · ${ordem.quantidadeRestante} restantes · ${eventos.length} eventos persistidos` }));
  const tabela = el("table", {},
    el("thead", {}, el("tr", {}, el("th", { texto: "Evento" }), el("th", { texto: "Papel" }), el("th", { texto: "Hora" }), el("th", { texto: "Detalhe" }))),
    el("tbody", {}, eventos.map((evento) => el("tr", {},
      el("td", { classe: "evento", texto: evento.tipo }),
      el("td", { texto: evento.papel === "agressora" ? "desta ordem" : `da ordem #${evento.ordemId}` }),
      el("td", { texto: hora(evento.em) }),
      el("td", { classe: "detalhe", texto: resumoDe(evento.detalhe || {}) })))));
  alvo.replaceChildren(cabeca, el("ol", { classe: "etapas" }, etapas), el("details", {}, el("summary", { texto: "Todos os eventos desta ordem" }), tabela));
}

async function rastrear(id) {
  document.querySelector("#ordem-id").value = id;
  estado.ordemRastreada = Number(id);
  try {
    desenharTrilha(await pegar(`/api/admin/ordens/${id}/trilha`));
  } catch (erro) {
    document.querySelector("#trilha").replaceChildren(el("p", { classe: "aviso", texto: erro.message }));
  }
}

async function carregarOrdensRecentes() {
  const ordens = await pegar("/api/admin/ordens/recentes");
  const alvo = document.querySelector("#ordens-recentes");
  if (ordens.length === 0) {
    alvo.replaceChildren(el("p", { classe: "legenda", texto: "Nenhuma ordem ainda. Envie uma pelo Home Broker." }));
    return;
  }
  alvo.replaceChildren(...ordens.slice(0, 10).map((ordem) => el("button", {
    type: "button",
    classe: `chip ${ordem.lado}`,
    texto: `#${ordem.id} ${ordem.ticker} ${ordem.lado}`,
    title: `${ordem.investidor} · ${ordem.status}`,
    onclick: () => rastrear(ordem.id),
  })));
}

let trilhaAgendada = null;

function conectarFluxo() {
  const fonte = new EventSource("/api/admin/logs/fluxo");
  const estadoFluxo = document.querySelector("#fluxo-estado");
  fonte.onopen = () => {
    estadoFluxo.textContent = "Recebendo ao vivo · cada linha é verificada ao chegar";
    marcarAoVivo("Logs ao vivo");
  };
  fonte.onmessage = (mensagem) => {
    const pacote = JSON.parse(mensagem.data);
    if (pacote.tipo === "metricas") {
      estado.historico.push(pacote.dados);
      if (estado.historico.length > 90) estado.historico.shift();
      desenharMonitor(pacote.dados);
      return;
    }
    if (pacote.tipo === "log") {
      verificarEntrada(pacote.entrada);
      const dados = JSON.parse(pacote.entrada.corpo);
      const alvo = estado.ordemRastreada;
      if (alvo && (dados.ordemId === alvo || dados.contraOrdemId === alvo) && !trilhaAgendada) {
        trilhaAgendada = setTimeout(() => {
          trilhaAgendada = null;
          rastrear(alvo);
        }, 300);
      }
    }
  };
  fonte.onerror = () => {
    estadoFluxo.textContent = "Fluxo caiu · reconectando";
    marcarAoVivo("Sem conexão", false);
  };
}

async function verificarServidor() {
  const cadeia = await pegar("/api/admin/logs/verificar");
  estado.servidor = { ...cadeia, em: new Date().toISOString() };
  desenharCadeia();
  return cadeia;
}

document.querySelector("#verificar-cadeia").addEventListener("click", (evento) => {
  comBotao(evento.currentTarget, "Verificando…", async () => {
    await carregarRecentes();
    const cadeia = await verificarServidor();
    toast(cadeia.integra
      ? `Cadeia íntegra: ${numeroBr(cadeia.verificados)} registros conferidos no servidor e no navegador.`
      : `Cadeia quebrada no registro #${cadeia.quebraEm}: ${cadeia.motivo}.`, cadeia.integra ? "ok" : "erro");
  });
});

document.querySelector("#adulterar").addEventListener("click", (evento) => {
  comBotao(evento.currentTarget, "Adulterando…", async () => {
    const { seq } = await enviar("/api/admin/logs/adulterar");
    await carregarRecentes();
    toast(seq ? `Registro #${seq} foi editado na memória do servidor. A verificação já acusou a quebra.` : "Ainda não há registros suficientes para adulterar.", seq ? "erro" : "info");
  });
});

document.querySelector("#restaurar").addEventListener("click", (evento) => {
  comBotao(evento.currentTarget, "Restaurando…", async () => {
    const { restaurados } = await enviar("/api/admin/logs/restaurar");
    await carregarRecentes();
    toast(`${restaurados} registro(s) restaurado(s). A cadeia volta a fechar.`, "ok");
  });
});

document.querySelector("#pausar").addEventListener("click", (evento) => {
  estado.pausado = !estado.pausado;
  evento.currentTarget.textContent = estado.pausado ? "Retomar" : "Pausar";
  document.querySelector("#fluxo-estado").textContent = estado.pausado
    ? "Pausado · os registros continuam chegando e sendo verificados"
    : "Recebendo ao vivo · cada linha é verificada ao chegar";
  if (!estado.pausado) agendarDesenho();
});

for (const filtro of ["#filtro-categoria", "#filtro-nivel", "#filtro-texto"]) {
  document.querySelector(filtro).addEventListener("input", desenharLogs);
}

document.querySelector("#form-trilha").addEventListener("submit", (evento) => {
  evento.preventDefault();
  rastrear(document.querySelector("#ordem-id").value);
});

document.querySelector("#rodar-sondas").addEventListener("click", (evento) => {
  comBotao(evento.currentTarget, "Atacando a própria API…", async () => {
    const resultados = await enviar("/api/admin/seguranca/sondas");
    const aprovadas = resultados.filter((item) => item.passou).length;
    document.querySelector("#sondas-resumo").textContent = `${aprovadas} de ${resultados.length} sondas barradas como esperado às ${hora(new Date())}. Os detalhes também entraram no log.`;
    document.querySelector("#sondas").replaceChildren(...resultados.map((item) => el("tr", {},
      el("td", {}, el("strong", { texto: item.requisito }), el("p", { classe: "legenda", texto: item.descricao })),
      el("td", { texto: item.esperado }),
      el("td", { texto: item.obtido }),
      el("td", { classe: item.passou ? "positivo" : "negativo", texto: item.passou ? "Protegido" : "Falhou" }))));
    toast(`${aprovadas} de ${resultados.length} sondas de segurança passaram.`, aprovadas === resultados.length ? "ok" : "erro");
  });
});

async function iniciar() {
  const { atual, historico } = await pegar("/api/admin/metricas");
  estado.historico = historico.slice(-90);
  desenharMonitor(atual);
  await carregarRecentes();
  await carregarOrdensRecentes();
  setInterval(() => carregarOrdensRecentes().catch(() => {}), 5000);
  conectarFluxo();
}

iniciar().catch((erro) => toast(erro.message, "erro"));
