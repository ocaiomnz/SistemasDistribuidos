const reais = (centavos) => (Number(centavos) / 100).toLocaleString("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const hora = (valor) => new Date(valor).toLocaleTimeString("pt-BR");

const numeroBr = (valor, casas = 0) => Number(valor).toLocaleString("pt-BR", {
  minimumFractionDigits: casas,
  maximumFractionDigits: casas,
});

const pct = (valor, casas = 1) => `${valor > 0 ? "+" : ""}${numeroBr(valor, casas)}%`;

async function lerJson(resposta) {
  const corpo = await resposta.json();
  if (!resposta.ok) throw new Error(corpo.erro || "Não foi possível concluir. Tente de novo.");
  return corpo;
}

async function pegar(caminho) {
  return lerJson(await fetch(caminho, { cache: "no-store" }));
}

async function enviar(caminho, corpo = {}, metodo = "POST") {
  return lerJson(await fetch(caminho, {
    method: metodo,
    cache: "no-store",
    headers: { "content-type": "application/json", "x-pregao": "1" },
    body: JSON.stringify(corpo),
  }));
}

function el(tag, propriedades = {}, ...filhos) {
  const elemento = document.createElement(tag);
  for (const [chave, valor] of Object.entries(propriedades)) {
    if (valor === undefined || valor === null || valor === false) continue;
    if (chave === "classe") elemento.className = valor;
    else if (chave === "texto") elemento.textContent = valor;
    else if (chave.startsWith("on")) elemento.addEventListener(chave.slice(2), valor);
    else elemento.setAttribute(chave, valor === true ? "" : valor);
  }
  for (const filho of filhos.flat()) {
    if (filho === null || filho === undefined || filho === false) continue;
    elemento.append(filho instanceof Node ? filho : document.createTextNode(String(filho)));
  }
  return elemento;
}

function toast(mensagem, tipo = "info") {
  const lista = document.querySelector("#toasts");
  const fechar = el("button", { type: "button", classe: "texto", "aria-label": "Fechar aviso", texto: "Fechar" });
  const item = el("div", { classe: `toast ${tipo}`, role: tipo === "erro" ? "alert" : "status" }, el("p", { texto: mensagem }), fechar);
  fechar.addEventListener("click", () => item.remove());
  lista.append(item);
  while (lista.children.length > 3) lista.firstElementChild.remove();
  setTimeout(() => item.remove(), tipo === "erro" ? 8000 : 4000);
}

function linhaVazia(colunas, titulo, detalhe) {
  return el("tr", {}, el("td", { colspan: colunas, classe: "vazio" }, el("strong", { texto: titulo }), el("p", { classe: "legenda", texto: detalhe })));
}

function grafico(valores, { largura = 160, altura = 40, classe = "" } = {}) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${largura} ${altura}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", `grafico ${classe}`.trim());
  svg.setAttribute("aria-hidden", "true");
  if (valores.length < 2) return svg;
  const minimo = Math.min(...valores);
  const maximo = Math.max(...valores);
  const faixa = maximo - minimo || 1;
  const pontos = valores.map((valor, indice) => {
    const x = (indice / (valores.length - 1)) * largura;
    const y = altura - 2 - ((valor - minimo) / faixa) * (altura - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linha = document.createElementNS(ns, "polyline");
  linha.setAttribute("points", pontos.join(" "));
  svg.append(linha);
  return svg;
}

async function comBotao(botao, rotuloOcupado, tarefa) {
  const original = botao.textContent;
  botao.disabled = true;
  botao.textContent = rotuloOcupado;
  try {
    return await tarefa();
  } catch (erro) {
    toast(erro.message, "erro");
    return null;
  } finally {
    botao.disabled = false;
    botao.textContent = original;
  }
}

function marcarAoVivo(texto, ok = true) {
  const selo = document.querySelector("#presenca");
  if (!selo) return;
  selo.textContent = texto;
  selo.classList.toggle("ok", ok);
}
