const base = process.env.BASE_URL || "http://127.0.0.1:3000";

function argumento(nome, padrao) {
  const indice = process.argv.indexOf(`--${nome}`);
  if (indice === -1) return padrao;
  return Number(process.argv[indice + 1]);
}

async function cadastrar(indice) {
  const email = `carga-${Date.now()}-${indice}@bolsa.local`;
  const resposta = await fetch(`${base}/cadastro`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ nome: `Carga ${indice}`, email, senha: "carga" }),
    redirect: "manual",
  });
  if (resposta.status >= 400) {
    throw new Error(`cadastro ${indice} falhou com HTTP ${resposta.status}`);
  }
  const cookie = (resposta.headers.getSetCookie?.() || []).map((item) => item.split(";")[0]).join("; ");
  if (!cookie) throw new Error(`cadastro ${indice} não devolveu sessão`);
  return cookie;
}

async function enviar(cookie, corpo) {
  const inicio = performance.now();
  const resposta = await fetch(`${base}/api/ordens`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pregao": "1", cookie },
    body: JSON.stringify(corpo),
  });
  const json = await resposta.json();
  return { ok: resposta.ok, ms: performance.now() - inicio, erro: json.erro || null };
}

const usuarios = argumento("usuarios", 5);
const ordens = argumento("ordens", 2);
const contas = [];
for (let i = 1; i <= usuarios; i += 1) {
  contas.push(await cadastrar(i));
}

const inicio = performance.now();
const tarefas = [];
for (const cookie of contas) {
  for (let n = 0; n < ordens; n += 1) {
    tarefas.push(enviar(cookie, {
      ticker: "CIAJ3",
      lado: "compra",
      quantidade: 5,
      preco: "20,00",
    }));
  }
}
const resultados = await Promise.all(tarefas);
const duracao = performance.now() - inicio;
const ok = resultados.filter((item) => item.ok).length;
const latencias = resultados.map((item) => item.ms).sort((a, b) => a - b);
const media = latencias.reduce((soma, valor) => soma + valor, 0) / latencias.length;

console.log(JSON.stringify({
  usuarios,
  ordensPorUsuario: ordens,
  enviadas: resultados.length,
  aceitas: ok,
  rejeitadas: resultados.length - ok,
  duracaoMs: Math.round(duracao),
  ordensPorSegundo: Number((resultados.length / (duracao / 1000)).toFixed(2)),
  latenciaMediaMs: Math.round(media),
  latenciaMaxMs: Math.round(latencias.at(-1) || 0),
}, null, 2));
