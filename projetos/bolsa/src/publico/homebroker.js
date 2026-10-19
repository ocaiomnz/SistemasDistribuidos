const estado = { ticker: "", ativos: [], confirmando: null, conectado: false, avisouQueda: false };

const reais = (centavos) => (Number(centavos) / 100).toLocaleString("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const precoCampo = (centavos) => (Number(centavos) / 100).toLocaleString("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const hora = (valor) => new Date(valor).toLocaleTimeString("pt-BR");

function variacao(atual, abertura) {
  if (!abertura) return { texto: "0,00%", classe: "" };
  const pct = ((atual - abertura) / abertura) * 100;
  const texto = `${pct > 0 ? "+" : ""}${pct.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
  return { texto, classe: pct > 0 ? "positivo" : pct < 0 ? "negativo" : "" };
}

function num(texto, classe = "") {
  return { texto: String(texto), classe: `num ${classe}`.trim() };
}

async function pegar(caminho) {
  return lerJson(await fetch(caminho, { cache: "no-store" }));
}

async function lerJson(resposta) {
  const corpo = await resposta.json();
  if (!resposta.ok) throw new Error(corpo.erro || "Não foi possível concluir. Tente de novo.");
  return corpo;
}

function toast(mensagem, tipo = "info") {
  const lista = document.querySelector("#toasts");
  const item = document.createElement("div");
  item.className = `toast ${tipo}`;
  item.setAttribute("role", tipo === "erro" ? "alert" : "status");
  const texto = document.createElement("p");
  texto.textContent = mensagem;
  const fechar = document.createElement("button");
  fechar.type = "button";
  fechar.className = "texto";
  fechar.textContent = "Fechar";
  fechar.setAttribute("aria-label", "Fechar aviso");
  fechar.addEventListener("click", () => item.remove());
  item.append(texto, fechar);
  lista.append(item);
  while (lista.children.length > 3) lista.firstElementChild.remove();
  setTimeout(() => item.remove(), tipo === "erro" ? 8000 : 4000);
}

function atualizarRotuloBotao() {
  const botao = document.querySelector("#enviar");
  if (botao.disabled) return;
  const lado = document.querySelector("input[name=lado]:checked")?.value;
  const ticker = document.querySelector("#ticker").value || "ativo";
  botao.textContent = lado === "venda" ? `Vender ${ticker}` : `Comprar ${ticker}`;
}

function atualizarAjudaLado() {
  const venda = document.querySelector("input[value=venda]").checked;
  document.querySelector("#ajuda-lado").textContent = venda
    ? "A venda reserva as ações até executar ou até você cancelar."
    : "A compra reserva o saldo pelo preço limite. Se executar mais barato, a diferença volta.";
  atualizarRotuloBotao();
}

function selecionarAtivo(ativo) {
  estado.ticker = ativo.ticker;
  document.querySelector("#preco").value = precoCampo(ativo.precoCentavos);
  atualizarRotuloBotao();
  carregar().catch((erro) => toast(erro.message, "erro"));
}

function desenharAtivos(ativos) {
  const lista = document.querySelector("#ativos");
  const seletor = document.querySelector("#ticker");
  estado.ativos = ativos;
  lista.replaceChildren();
  seletor.replaceChildren();
  for (const ativo of ativos) {
    const mudanca = variacao(ativo.precoCentavos, ativo.precoAberturaCentavos);
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "ativo";
    if (ativo.ticker === estado.ticker) {
      botao.classList.add("selecionado");
      botao.setAttribute("aria-current", "true");
    }
    const codigo = document.createElement("span");
    codigo.className = "ativo-codigo";
    codigo.textContent = ativo.ticker;
    const variacaoEl = document.createElement("span");
    variacaoEl.className = `ativo-variacao ${mudanca.classe}`;
    variacaoEl.textContent = mudanca.texto;
    const nome = document.createElement("span");
    nome.className = "ativo-nome";
    nome.textContent = ativo.nome;
    const preco = document.createElement("span");
    preco.className = "ativo-preco";
    preco.textContent = reais(ativo.precoCentavos);
    const volume = document.createElement("span");
    volume.className = "ativo-volume";
    volume.textContent = ativo.suspensao
      ? `Suspenso até ${hora(ativo.suspensao.ate)}`
      : `${ativo.volume} ações desde a abertura`;
    if (ativo.suspensao) botao.classList.add("suspenso");
    botao.append(codigo, variacaoEl, nome, preco, volume);
    botao.addEventListener("click", () => selecionarAtivo(ativo));
    lista.append(botao);

    const opcao = document.createElement("option");
    opcao.value = ativo.ticker;
    opcao.textContent = `${ativo.ticker} · ${ativo.nome}`;
    opcao.selected = ativo.ticker === estado.ticker;
    seletor.append(opcao);
  }
  atualizarRotuloBotao();
}

function linha(celulas) {
  const tr = document.createElement("tr");
  for (const celula of celulas) {
    const td = document.createElement("td");
    if (celula && typeof celula === "object") {
      td.textContent = celula.texto;
      td.className = celula.classe;
    } else {
      td.textContent = String(celula);
    }
    tr.append(td);
  }
  return tr;
}

function vazio(colunas, titulo, detalhe) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = colunas;
  td.className = "vazio";
  const forte = document.createElement("strong");
  forte.textContent = titulo;
  const texto = document.createElement("p");
  texto.className = "legenda";
  texto.textContent = detalhe;
  td.append(forte, texto);
  tr.append(td);
  return tr;
}

function desenharCotacao(mercado) {
  const ativo = mercado.ativos.find((item) => item.ticker === mercado.ticker);
  document.querySelector("#ticker-livro").textContent = mercado.ticker;
  if (!ativo) return;
  const mudanca = variacao(ativo.precoCentavos, ativo.precoAberturaCentavos);
  document.querySelector("#cotacao-ticker").textContent = ativo.ticker;
  document.querySelector("#cotacao-nome").textContent = ativo.nome;
  document.querySelector("#cotacao-preco").textContent = reais(ativo.precoCentavos);
  const contexto = document.querySelector("#cotacao-contexto");
  if (ativo.suspensao) {
    contexto.textContent = `Negociação suspensa por circuit breaker até ${hora(ativo.suspensao.ate)}: ${ativo.suspensao.motivo}. Novas ordens serão recusadas até lá.`;
    contexto.className = "contexto alerta";
    return;
  }
  contexto.textContent = `${mudanca.texto} desde a abertura de ${reais(ativo.precoAberturaCentavos)} · ${ativo.volume} ações negociadas`;
  contexto.className = `contexto ${mudanca.classe}`;
}

function desenharLivro(mercado) {
  const compras = document.querySelector("#compras");
  const vendas = document.querySelector("#vendas");
  compras.replaceChildren(...mercado.compras.map((oferta, indice) => {
    const tr = linha([
      oferta.investidor,
      num(oferta.quantidade),
      num(reais(oferta.precoCentavos), "compra"),
    ]);
    if (indice === 0) tr.classList.add("melhor");
    return tr;
  }));
  vendas.replaceChildren(...mercado.vendas.map((oferta, indice) => {
    const tr = linha([
      num(reais(oferta.precoCentavos), "venda"),
      num(oferta.quantidade),
      oferta.investidor,
    ]);
    if (indice === 0) tr.classList.add("melhor");
    return tr;
  }));
  if (mercado.compras.length === 0) {
    compras.append(vazio(3, "Nenhuma compra no livro.", "Uma ordem de compra abaixo das vendas fica esperando aqui."));
  }
  if (mercado.vendas.length === 0) {
    vendas.append(vazio(3, "Nenhuma venda no livro.", "Quem tem o ativo pode deixar uma oferta limitada deste lado."));
  }
  const negocios = document.querySelector("#negociacoes");
  if (mercado.negociacoes.length === 0) {
    negocios.replaceChildren(vazio(5, "Nenhum negócio neste ativo ainda.", "O primeiro cruzamento de compra e venda aparece aqui."));
    return;
  }
  negocios.replaceChildren(...mercado.negociacoes.map((negocio) => linha([
    hora(negocio.executadaEm),
    num(negocio.quantidade),
    num(reais(negocio.precoCentavos)),
    negocio.comprador,
    negocio.vendedor,
  ])));
}

function metrica(rotulo, valor) {
  const bloco = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = rotulo;
  dd.textContent = valor;
  bloco.append(dt, dd);
  return bloco;
}

function desenharCarteira(dados) {
  document.querySelector("#patrimonio").textContent = reais(dados.patrimonioCentavos);
  const contexto = document.querySelector("#patrimonio-contexto");
  contexto.textContent = `${reais(dados.lucroCentavos)} em relação ao capital inicial de ${reais(dados.capitalInicialCentavos)}.`;
  contexto.className = `contexto ${dados.lucroCentavos > 0 ? "positivo" : dados.lucroCentavos < 0 ? "negativo" : ""}`;
  document.querySelector("#resumo").replaceChildren(
    metrica("Saldo disponível", reais(dados.saldoCentavos)),
    metrica("Reservado em ordens", reais(dados.reservadoCentavos)),
  );
  const corpo = document.querySelector("#posicoes");
  if (dados.posicoes.length === 0) {
    corpo.replaceChildren(vazio(4, "Nenhuma ação na carteira.", "Compre um ativo para a posição aparecer aqui."));
    return;
  }
  corpo.replaceChildren(...dados.posicoes.map((posicao) => linha([
    posicao.ticker,
    num(`${posicao.quantidade} (${posicao.quantidadeReservada} reservadas)`),
    num(reais(posicao.precoMedioCentavos)),
    num(reais(posicao.resultadoCentavos), posicao.resultadoCentavos > 0 ? "positivo" : posicao.resultadoCentavos < 0 ? "negativo" : ""),
  ])));
}

async function consultarOrdem(id) {
  const ordem = await pegar(`/api/ordens/${id}`);
  const texto = `Ordem ${ordem.id}: ${ordem.lado} de ${ordem.quantidade} ${ordem.ticker} a ${reais(ordem.precoCentavos)}. Restam ${ordem.quantidadeRestante}. Status: ${ordem.status}.`;
  document.querySelector("#detalhe-ordem").textContent = texto;
  toast(texto, "info");
}

function botaoAcao(rotulo, classe, aoClicar) {
  const botao = document.createElement("button");
  botao.type = "button";
  botao.className = classe;
  botao.textContent = rotulo;
  botao.addEventListener("click", aoClicar);
  return botao;
}

function desenharOrdens(ordens) {
  const corpo = document.querySelector("#minhas-ordens");
  corpo.replaceChildren();
  if (ordens.length === 0) {
    corpo.append(vazio(5, "Nenhuma ordem sua.", "Use Nova ordem, ao lado, para enviar a primeira."));
    return;
  }
  for (const ordem of ordens) {
    const tr = linha([
      String(ordem.id),
      ordem.ticker,
      ordem.lado,
      `${ordem.status} · ${ordem.quantidadeRestante}/${ordem.quantidade}`,
    ]);
    const td = document.createElement("td");
    const acoes = document.createElement("div");
    acoes.className = "acoes";
    if (estado.confirmando === ordem.id) {
      const aviso = document.createElement("p");
      aviso.className = "legenda";
      aviso.textContent = `Cancelar a ordem ${ordem.id}? O que ficou reservado volta para a conta.`;
      acoes.append(
        aviso,
        botaoAcao("Confirmar cancelamento", "perigo", async () => {
          try {
            await lerJson(await fetch(`/api/ordens/${ordem.id}`, {
              method: "DELETE",
              cache: "no-store",
              headers: { "x-pregao": "1" },
            }));
            estado.confirmando = null;
            toast(`Ordem ${ordem.id} cancelada. O valor reservado voltou para a conta.`, "ok");
            await carregar();
          } catch (erro) {
            toast(erro.message, "erro");
          }
        }),
        botaoAcao("Voltar", "secundario", () => {
          estado.confirmando = null;
          desenharOrdens(ordens);
        }),
      );
    } else {
      acoes.append(botaoAcao("Ver status", "texto", () => {
        consultarOrdem(ordem.id).catch((erro) => toast(erro.message, "erro"));
      }));
      if (ordem.status === "aberta" || ordem.status === "parcial") {
        const cancelar = botaoAcao("Cancelar", "perigo", () => {
          estado.confirmando = ordem.id;
          desenharOrdens(ordens);
        });
        cancelar.setAttribute("aria-label", `Cancelar ordem ${ordem.id}`);
        acoes.append(cancelar);
      }
    }
    td.append(acoes);
    tr.append(td);
    corpo.append(tr);
  }
}

function desenharNoticias(noticias = []) {
  const lista = document.querySelector("#noticias");
  lista.replaceChildren();
  if (noticias.length === 0) {
    const vazio = document.createElement("li");
    vazio.className = "legenda";
    vazio.textContent = "Nenhuma notícia por enquanto.";
    lista.append(vazio);
    return;
  }
  for (const noticia of noticias) {
    const item = document.createElement("li");
    item.className = noticia.tom;
    const titulo = document.createElement("strong");
    titulo.textContent = noticia.titulo;
    const contexto = document.createElement("span");
    contexto.className = "legenda";
    contexto.textContent = `${noticia.ticker || "Mercado inteiro"} · ${noticia.tom} · ${new Date(noticia.em).toLocaleTimeString("pt-BR")}`;
    item.append(titulo, contexto);
    lista.append(item);
  }
}

function marcarPresenca(conectados) {
  const selo = document.querySelector("#presenca");
  if (!estado.conectado) return;
  selo.textContent = `Ao vivo · ${conectados} no pregão`;
  selo.classList.add("ok");
}

let consulta = 0;

async function carregar() {
  const atual = ++consulta;
  const [mercado, dadosCarteira, ordens] = await Promise.all([
    pegar(`/api/mercado?ticker=${encodeURIComponent(estado.ticker)}`),
    pegar("/api/carteira"),
    pegar("/api/ordens"),
  ]);
  if (atual !== consulta) return;
  estado.ticker = mercado.ticker;
  desenharAtivos(mercado.ativos);
  desenharCotacao(mercado);
  desenharLivro(mercado);
  desenharCarteira(dadosCarteira);
  desenharOrdens(ordens);
  desenharNoticias(mercado.noticias);
  marcarPresenca(mercado.conectados);
  document.querySelector("#conteudo").setAttribute("aria-busy", "false");
}

let cargaAgendada = null;

function agendarCarga() {
  if (cargaAgendada) return;
  cargaAgendada = setTimeout(() => {
    cargaAgendada = null;
    carregar().catch((erro) => toast(erro.message, "erro"));
  }, 400);
}

function conectarEventos() {
  const fonte = new EventSource("/eventos");
  const selo = document.querySelector("#presenca");
  fonte.onopen = () => {
    estado.conectado = true;
    if (estado.avisouQueda) {
      toast("Conexão restabelecida. O livro foi atualizado.", "ok");
      estado.avisouQueda = false;
      carregar().catch((erro) => toast(erro.message, "erro"));
    }
    selo.classList.add("ok");
  };
  fonte.onmessage = (mensagem) => {
    const evento = JSON.parse(mensagem.data);
    if (evento.tipo === "BREAKER") {
      toast("O circuit breaker mudou de estado. Ativos suspensos aparecem marcados na lista.", "info");
    }
    if (evento.tipo === "NOTICIA") {
      toast(`Notícia · ${evento.ticker || "Mercado inteiro"}: ${evento.titulo}`, "info");
    }
    if (evento.tipo === "MERCADO_ZERADO") {
      toast("O mercado foi zerado pelo ADMIN. A página vai recarregar com o pregão do início.", "info");
      setTimeout(() => location.reload(), 2500);
      return;
    }
    if (evento.tipo === "RODADA_RECOMECADA") {
      toast("O pregão recomeçou: preços voltaram ao valor justo e as ordens abertas foram canceladas, com o valor reservado devolvido.", "info");
    }
    agendarCarga();
  };
  fonte.onerror = () => {
    estado.conectado = false;
    selo.classList.remove("ok");
    selo.textContent = "Sem conexão · tentando de novo";
    if (!estado.avisouQueda) {
      toast("A ligação com o pregão caiu. As ordens abertas continuam no servidor.", "erro");
      estado.avisouQueda = true;
    }
  };
}

document.querySelector("#form-ordem").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const formulario = evento.currentTarget;
  const botao = document.querySelector("#enviar");
  const dados = new FormData(formulario);
  botao.disabled = true;
  botao.textContent = "Enviando ordem…";
  try {
    const resposta = await fetch("/api/ordens", {
      cache: "no-store",
      method: "POST",
      headers: { "content-type": "application/json", "x-pregao": "1" },
      body: JSON.stringify({
        ticker: dados.get("ticker"),
        lado: dados.get("lado"),
        quantidade: Number(dados.get("quantidade")),
        preco: dados.get("preco"),
      }),
    });
    const resultado = await lerJson(resposta);
    toast(resultado.negocios.length
      ? `Ordem ${resultado.ordemId} gerou ${resultado.negocios.length} negócio(s).`
      : `Ordem ${resultado.ordemId} ficou ${resultado.status}. O que não executou continua no livro.`, "ok");
    await carregar();
  } catch (erro) {
    toast(erro.message, "erro");
  } finally {
    botao.disabled = false;
    atualizarRotuloBotao();
  }
});

document.querySelector("#ticker").addEventListener("change", (evento) => {
  const ativo = estado.ativos.find((item) => item.ticker === evento.target.value);
  if (ativo) selecionarAtivo(ativo);
});

for (const radio of document.querySelectorAll("input[name=lado]")) {
  radio.addEventListener("change", atualizarAjudaLado);
}

carregar().then(conectarEventos).catch((erro) => toast(erro.message, "erro"));
