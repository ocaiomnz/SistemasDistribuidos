import { Router } from "express";
import bcrypt from "bcryptjs";
import { numero, pool } from "../banco.js";
import { ErroNegocio } from "../erros.js";
import { registrar } from "../log.js";
import {
  adulterarRegistro,
  assinar,
  historicoMetricas,
  recentes,
  restaurarRegistros,
  snapshotAtual,
  verificarCadeia,
} from "../observabilidade.js";
import { exigirAdmin } from "../seguranca.js";
import { asyncRota, exigirLogin, inteiroEntre, numeroEntre, tickerValido } from "../util.js";
import { cargaEmAndamento, historicoCarga, iniciarCarga } from "../carga.js";
import { configurarAgentes, criarRobos, encerrarRobos, estadoAgentes } from "../mercado/agentes.js";
import {
  aplicarAlavancagem,
  configCaos,
  criarBaleia,
  encerrarBaleia,
  estadoBaleias,
  ganhoExtraordinario,
  quebrarAgente,
  reanimarQuebrados,
} from "../mercado/caos.js";
import { historicoPrecos, listarAtivos, ranking, trilhaDaOrdem, ultimasOrdens } from "../mercado/consultas.js";
import { PERFIS, PERFIS_SORTEAVEIS } from "../mercado/estrategias.js";
import { flushMercado } from "../mercado/flush.js";
import {
  MODELOS,
  configurarMundo,
  estadoMundo,
  noticiasRecentes,
  recomecarRodada,
  resultadoDoMercado,
  soltarNoticia,
} from "../mercado/mundo.js";
import {
  abrirServico,
  configMercado,
  estadoProtecoes,
  fecharServico,
  injetarFalha,
  liberarAtivo,
  liberarMercado,
  suspenderAtivo,
  suspenderMercado,
  suspensaoDe,
} from "../mercado/protecao.js";

export const admin = Router();
admin.use("/api/admin", exigirLogin, exigirAdmin);

function auditar(req, evento, dados = {}) {
  registrar(evento, { adminId: req.session.usuarioId, ...dados });
}

async function tickerExistente(valor) {
  const ticker = tickerValido(valor);
  const ativos = await listarAtivos();
  if (!ativos.some((ativo) => ativo.ticker === ticker)) throw new ErroNegocio("Ativo inexistente.", "validacao");
  return ticker;
}

async function agenteAlvo(valor) {
  if (valor) {
    const id = inteiroEntre(valor, 1, 1e9, "Agente");
    const [linhas] = await pool.query("SELECT id FROM usuarios WHERE id = ? AND agente = 1 AND estado = 'ativo'", [id]);
    if (linhas.length === 0) throw new ErroNegocio("Agente não encontrado ou fora de atividade.");
    return id;
  }
  const [linhas] = await pool.query(
    `SELECT id FROM usuarios WHERE agente = 1 AND estado = 'ativo' AND email NOT LIKE 'agente-%'
       AND (perfil IS NULL OR perfil <> 'baleia') ORDER BY RAND() LIMIT 1`
  );
  if (linhas.length === 0) throw new ErroNegocio("Nenhum robô ativo para sortear. Crie perfis na aba Admin.");
  return numero(linhas[0].id);
}

admin.get("/api/admin/logs/recentes", (req, res) => {
  const limite = Math.min(2000, Math.max(1, Number(req.query.limite) || 400));
  res.json({ entradas: recentes(limite), cadeia: verificarCadeia() });
});

admin.get("/api/admin/logs/fluxo", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("retry: 2000\n\n");
  const sair = assinar(res);
  auditar(req, "ADMIN_LOGS_ASSINADOS");
  req.on("close", sair);
});

admin.get("/api/admin/logs/verificar", (_req, res) => {
  res.json(verificarCadeia());
});

admin.post("/api/admin/logs/adulterar", (req, res) => {
  const seq = adulterarRegistro();
  auditar(req, "LOG_ADULTERADO", { seq, aviso: "simulação para demonstrar a detecção pela cadeia de hashes" });
  res.json({ seq, cadeia: verificarCadeia() });
});

admin.post("/api/admin/logs/restaurar", (req, res) => {
  const restaurados = restaurarRegistros();
  auditar(req, "ADMIN_LOGS_RESTAURADOS", { restaurados });
  res.json({ restaurados, cadeia: verificarCadeia() });
});

admin.get("/api/admin/ordens/recentes", asyncRota(async (_req, res) => {
  res.json(await ultimasOrdens(20));
}));

admin.get("/api/admin/ordens/:id/trilha", asyncRota(async (req, res) => {
  const id = inteiroEntre(req.params.id, 1, 1e12, "Ordem");
  const trilha = await trilhaDaOrdem(id);
  if (!trilha) {
    res.status(404).json({ erro: `Ordem #${id} não existe.` });
    return;
  }
  res.json(trilha);
}));

admin.get("/api/admin/metricas", asyncRota(async (_req, res) => {
  res.json({ atual: await snapshotAtual(), historico: historicoMetricas() });
}));

async function contaDeSonda() {
  const email = "sonda@bolsa.local";
  const senha = "sonda-de-seguranca";
  const [linhas] = await pool.query("SELECT id FROM usuarios WHERE email = ?", [email]);
  if (linhas.length > 0) return { id: numero(linhas[0].id), email, senha };
  const hash = await bcrypt.hash(senha, 4);
  const [insercao] = await pool.query(
    `INSERT INTO usuarios (nome, email, senha_hash, saldo_centavos, capital_inicial_centavos, agente, perfil)
     VALUES ('Sonda de Segurança', ?, ?, 100000, 100000, 0, 'sonda')`,
    [email, hash]
  );
  return { id: insercao.insertId, email, senha };
}

async function chamar(caminho, { metodo = "GET", cookie, corpo, cabecalhos = {}, formulario } = {}) {
  const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
  const resposta = await fetch(`${base}${caminho}`, {
    method: metodo,
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(corpo ? { "content-type": "application/json" } : {}),
      ...(formulario ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...cabecalhos,
    },
    body: corpo ? JSON.stringify(corpo) : formulario ? new URLSearchParams(formulario) : undefined,
  });
  let json = null;
  try {
    json = await resposta.clone().json();
  } catch {
    // páginas HTML
  }
  return { status: resposta.status, json, cookies: resposta.headers.getSetCookie?.() || [] };
}

admin.post("/api/admin/seguranca/sondas", asyncRota(async (req, res) => {
  const sonda = await contaDeSonda();
  const login = await chamar("/entrar", { metodo: "POST", formulario: { email: sonda.email, senha: sonda.senha } });
  const cookie = login.cookies.map((item) => item.split(";")[0]).join("; ");
  const [alheias] = await pool.query(
    "SELECT id FROM ordens WHERE usuario_id <> ? AND status IN ('aberta', 'parcial') ORDER BY id DESC LIMIT 1",
    [sonda.id]
  );
  const [antes] = await pool.query("SELECT saldo_centavos FROM usuarios WHERE id = ?", [sonda.id]);
  const resultados = [];
  async function sondar(requisito, descricao, esperado, executar) {
    let obtido;
    try {
      obtido = await executar();
    } catch (erro) {
      obtido = `erro: ${erro.message}`;
    }
    const passou = String(obtido).startsWith(String(esperado));
    resultados.push({ requisito, descricao, esperado: String(esperado), obtido: String(obtido), passou });
    registrar("SONDA_SEGURANCA", { requisito, descricao, esperado: String(esperado), obtido: String(obtido), passou }, passou ? "info" : "erro");
  }

  await sondar("Autenticação", "Ler carteira sem sessão", 401, async () => (await chamar("/api/carteira")).status);
  await sondar("Autenticação", "Cookie de sessão é HttpOnly e SameSite", "HttpOnly+SameSite", async () => {
    const texto = login.cookies.join(";");
    return /HttpOnly/i.test(texto) && /SameSite=Lax/i.test(texto) ? "HttpOnly+SameSite" : texto || "sem cookie";
  });
  await sondar("Autorização", "Investidor comum abre métricas do ADMIN", 403, async () => (await chamar("/api/admin/metricas", { cookie })).status);
  await sondar("Autorização", "Investidor comum aciona circuit breaker", 403, async () => (await chamar("/api/admin/caos/breaker", {
    metodo: "POST", cookie, corpo: { escopo: "mercado", duracaoS: 30 }, cabecalhos: { "x-pregao": "1" },
  })).status);
  await sondar("Proteção das operações", "Ordem sem cabeçalho anti-CSRF", 403, async () => (await chamar("/api/ordens", {
    metodo: "POST", cookie, corpo: { ticker: "CIAJ3", lado: "compra", quantidade: 1, preco: "1,00" },
  })).status);
  await sondar("Validação", "Quantidade negativa e preço inválido", 400, async () => (await chamar("/api/ordens", {
    metodo: "POST", cookie, corpo: { ticker: "CIAJ3", lado: "compra", quantidade: -5, preco: "abc" }, cabecalhos: { "x-pregao": "1" },
  })).status);
  await sondar("Validação", "Ticker com injeção SQL", 400, async () => (await chamar("/api/ordens", {
    metodo: "POST", cookie, corpo: { ticker: "CIAJ3' OR 1=1 --", lado: "compra", quantidade: 1, preco: "1,00" }, cabecalhos: { "x-pregao": "1" },
  })).status);
  await sondar("Saldo e carteira", "Forjar usuarioId no corpo da ordem", 400, async () => (await chamar("/api/ordens", {
    metodo: "POST", cookie, corpo: { ticker: "CIAJ3", lado: "compra", quantidade: 1, preco: "1,00", usuarioId: 1 }, cabecalhos: { "x-pregao": "1" },
  })).status);
  await sondar("Saldo e carteira", "Comprar além do saldo", 400, async () => (await chamar("/api/ordens", {
    metodo: "POST", cookie, corpo: { ticker: "CIAJ3", lado: "compra", quantidade: 100000, preco: "999,00" }, cabecalhos: { "x-pregao": "1" },
  })).status);
  await sondar("Saldo e carteira", "Vender ações que não possui", 400, async () => (await chamar("/api/ordens", {
    metodo: "POST", cookie, corpo: { ticker: "CIAJ3", lado: "venda", quantidade: 50, preco: "1,00" }, cabecalhos: { "x-pregao": "1" },
  })).status);
  await sondar("Saldo e carteira", "Banco recusa saldo negativo (CHECK)", "recusado", async () => {
    try {
      await pool.query("UPDATE usuarios SET saldo_centavos = -1 WHERE id = ?", [sonda.id]);
      return "aceito";
    } catch (erro) {
      return `recusado (${erro.code})`;
    }
  });
  await sondar("Saldo e carteira", "Saldo da sonda permaneceu igual", "igual", async () => {
    const [depois] = await pool.query("SELECT saldo_centavos FROM usuarios WHERE id = ?", [sonda.id]);
    return numero(depois[0].saldo_centavos) === numero(antes[0].saldo_centavos) ? "igual" : "alterado";
  });
  await sondar("Ordens alheias", "Cancelar ordem de outro investidor", alheias.length ? 403 : "sem ordem alheia aberta", async () => {
    if (!alheias.length) return "sem ordem alheia aberta";
    return (await chamar(`/api/ordens/${alheias[0].id}`, { metodo: "DELETE", cookie, cabecalhos: { "x-pregao": "1" } })).status;
  });
  await sondar("Ordens alheias", "Consultar ordem de outro investidor", alheias.length ? 404 : "sem ordem alheia aberta", async () => {
    if (!alheias.length) return "sem ordem alheia aberta";
    return (await chamar(`/api/ordens/${alheias[0].id}`, { cookie })).status;
  });
  await sondar("Controle de acesso", "Abrir página O Caos como investidor", 403, async () => (await chamar("/caos", { cookie })).status);
  await sondar("Autenticação", "Força bruta no login (6ª tentativa)", 429, async () => {
    const alvo = `forca-bruta-${Date.now()}@bolsa.local`;
    let status = 0;
    for (let i = 0; i < 6; i += 1) {
      status = (await chamar("/entrar", { metodo: "POST", formulario: { email: alvo, senha: "errada" } })).status;
    }
    return status;
  });

  auditar(req, "ADMIN_SONDAS_EXECUTADAS", {
    total: resultados.length,
    aprovadas: resultados.filter((item) => item.passou).length,
  });
  res.json(resultados);
}));

admin.get("/api/admin/caos", asyncRota(async (_req, res) => {
  const ativos = await listarAtivos();
  const historicos = Object.fromEntries(
    await Promise.all(ativos.map(async (ativo) => [ativo.ticker, await historicoPrecos(ativo.ticker, 60)]))
  );
  res.json({
    protecoes: estadoProtecoes(),
    caos: configCaos,
    baleias: await estadoBaleias(),
    agentes: await estadoAgentes(),
    ativos: ativos.map((ativo) => ({ ...ativo, suspensao: suspensaoDe(ativo.ticker), historico: historicos[ativo.ticker] })),
  });
}));

admin.post("/api/admin/caos/breaker", asyncRota(async (req, res) => {
  const duracaoS = inteiroEntre(req.body.duracaoS, 5, 600, "Duração");
  if (req.body.escopo === "mercado") {
    suspenderMercado(duracaoS, "acionado manualmente pelo ADMIN", `admin:${req.session.usuarioId}`);
  } else {
    const ticker = await tickerExistente(req.body.ticker);
    suspenderAtivo(ticker, duracaoS, "acionado manualmente pelo ADMIN", `admin:${req.session.usuarioId}`);
  }
  res.json(estadoProtecoes());
}));

admin.post("/api/admin/caos/breaker/liberar", asyncRota(async (req, res) => {
  if (req.body.ticker) {
    liberarAtivo(await tickerExistente(req.body.ticker));
  } else {
    liberarMercado();
  }
  res.json(estadoProtecoes());
}));

admin.post("/api/admin/caos/breaker/config", (req, res) => {
  configMercado.automatico = Boolean(req.body.automatico);
  configMercado.limitePct = numeroEntre(req.body.limitePct, 1, 50, "Limite de variação");
  configMercado.duracaoS = inteiroEntre(req.body.duracaoS, 5, 600, "Duração");
  auditar(req, "ADMIN_BREAKER_CONFIGURADO", { ...configMercado });
  res.json(estadoProtecoes());
});

admin.post("/api/admin/caos/servico", (req, res) => {
  const acao = req.body.acao;
  if (acao === "falha") {
    injetarFalha(inteiroEntre(req.body.segundos, 5, 120, "Duração da falha"));
  } else if (acao === "abrir") {
    abrirServico("aberto manualmente pelo ADMIN", `admin:${req.session.usuarioId}`);
  } else if (acao === "fechar") {
    fecharServico();
  } else {
    throw new ErroNegocio("Ação do breaker de serviço desconhecida.", "validacao");
  }
  res.json(estadoProtecoes());
});

admin.post("/api/admin/caos/alavancagem", asyncRota(async (req, res) => {
  const fator = numeroEntre(req.body.fator, 1, 10, "Alavancagem");
  res.json(await aplicarAlavancagem(fator));
}));

admin.post("/api/admin/caos/roleta", (req, res) => {
  configCaos.roleta.ativa = Boolean(req.body.ativa);
  configCaos.roleta.chanceGanho = numeroEntre(req.body.chanceGanhoPct, 0, 50, "Chance de ganho") / 100;
  configCaos.roleta.chanceQuebra = numeroEntre(req.body.chanceQuebraPct, 0, 50, "Chance de quebra") / 100;
  auditar(req, "CAOS_ROLETA", { ...configCaos.roleta });
  res.json(configCaos);
});

admin.post("/api/admin/caos/reanimar", asyncRota(async (req, res) => {
  const quantidade = await reanimarQuebrados();
  auditar(req, "ADMIN_AGENTES_REANIMADOS", { quantidade });
  res.json({ quantidade });
}));

admin.post("/api/admin/caos/agente/:acao", asyncRota(async (req, res) => {
  const usuarioId = await agenteAlvo(req.body.usuarioId);
  if (req.params.acao === "ganho") {
    res.json({ usuarioId, deltaCentavos: await ganhoExtraordinario(usuarioId, `admin:${req.session.usuarioId}`) });
  } else if (req.params.acao === "quebra") {
    await quebrarAgente(usuarioId, `admin:${req.session.usuarioId}`);
    res.json({ usuarioId, quebrado: true });
  } else {
    throw new ErroNegocio("Ação desconhecida.", "validacao");
  }
}));

admin.post("/api/admin/caos/baleia", asyncRota(async (req, res) => {
  const ticker = await tickerExistente(req.body.ticker);
  const id = await criarBaleia({
    ticker,
    capitalCentavos: inteiroEntre(req.body.capitalReais, 10_000, 100_000_000, "Capital") * 100,
    alavancagem: numeroEntre(req.body.alavancagem, 1, 10, "Alavancagem"),
    alvoParticipacaoPct: numeroEntre(req.body.alvoParticipacaoPct, 5, 95, "Meta de participação"),
    alvoLucroPct: numeroEntre(req.body.alvoLucroPct, 1, 500, "Meta de lucro"),
  });
  auditar(req, "ADMIN_BALEIA_SOLTA", { baleiaId: id, ticker });
  res.status(201).json({ id });
}));

admin.post("/api/admin/caos/baleia/:id/sair", asyncRota(async (req, res) => {
  const ok = await encerrarBaleia(inteiroEntre(req.params.id, 1, 1e9, "Baleia"));
  if (!ok) throw new ErroNegocio("Baleia não encontrada ou já fora do mercado.");
  auditar(req, "ADMIN_BALEIA_RECOLHIDA", { baleiaId: Number(req.params.id) });
  res.json({ ok });
}));

admin.get("/api/admin/mundo", asyncRota(async (_req, res) => {
  const ativos = await listarAtivos();
  const historicos = Object.fromEntries(
    await Promise.all(ativos.map(async (ativo) => [ativo.ticker, await historicoPrecos(ativo.ticker, 60)]))
  );
  const mundo = await estadoMundo();
  res.json({
    ...mundo,
    modelos: MODELOS,
    ativos: ativos.map((ativo) => ({
      ...ativo,
      ...mundo.ativos.find((item) => item.ticker === ativo.ticker),
      suspensao: suspensaoDe(ativo.ticker),
      historico: historicos[ativo.ticker],
    })),
    noticias: await noticiasRecentes(15),
    resultado: await resultadoDoMercado(),
  });
}));

admin.post("/api/admin/mundo/noticia", asyncRota(async (req, res) => {
  const ticker = req.body.ticker ? await tickerExistente(req.body.ticker) : null;
  const titulo = String(req.body.titulo ?? "").trim();
  if (titulo.length < 3 || titulo.length > 120) {
    throw new ErroNegocio("Escreva a manchete com 3 a 120 caracteres.", "validacao");
  }
  const impactoPct = numeroEntre(req.body.impactoPct, -40, 40, "Intensidade");
  if (impactoPct === 0) throw new ErroNegocio("Uma notícia de impacto 0% não muda nada. Escolha outra intensidade.", "validacao");
  const noticia = await soltarNoticia({ ticker, titulo, impactoPct, origem: "admin", adminId: req.session.usuarioId });
  res.status(201).json(noticia);
}));

admin.post("/api/admin/mundo/config", (req, res) => {
  const config = configurarMundo({
    automaticas: Boolean(req.body.automaticas),
    intervaloS: inteiroEntre(req.body.intervaloS, 10, 600, "Intervalo entre notícias"),
    meiaVidaS: inteiroEntre(req.body.meiaVidaS, 15, 1800, "Meia-vida da confiança"),
  });
  auditar(req, "ADMIN_MUNDO_CONFIGURADO", config);
  res.json(config);
});

admin.post("/api/admin/mundo/recomecar", asyncRota(async (req, res) => {
  const resumo = await recomecarRodada(req.session.usuarioId);
  if (!resumo) {
    res.status(409).json({ erro: "Uma rodada já está sendo recomeçada. Aguarde alguns segundos." });
    return;
  }
  auditar(req, "ADMIN_RODADA_RECOMECADA", { contasReequilibradas: resumo.contasReequilibradas });
  res.json(resumo);
}));

admin.post("/api/admin/mercado/flush", asyncRota(async (req, res) => {
  if (req.body.confirmacao !== "FLUSH") {
    throw new ErroNegocio("Digite FLUSH, em maiúsculas, para confirmar.", "validacao");
  }
  const resumo = await flushMercado({ adminId: req.session.usuarioId, apagarHumanos: Boolean(req.body.apagarHumanos) });
  if (!resumo) {
    res.status(409).json({ erro: "O mercado já está sendo zerado. Aguarde alguns segundos." });
    return;
  }
  res.json(resumo);
}));

admin.get("/api/admin/painel", asyncRota(async (_req, res) => {
  res.json({
    agentes: await estadoAgentes(),
    perfis: Object.fromEntries(Object.entries(PERFIS).map(([id, perfil]) => [id, perfil])),
    ranking: (await ranking()).slice(0, 40),
    carga: cargaEmAndamento(),
    historicoCarga: await historicoCarga(),
  });
}));

admin.post("/api/admin/robos", asyncRota(async (req, res) => {
  const perfis = Array.isArray(req.body.perfis) ? req.body.perfis.filter((p) => PERFIS_SORTEAVEIS.includes(p)) : [];
  const capitalMin = inteiroEntre(req.body.capitalMinReais, 1_000, 10_000_000, "Capital mínimo");
  const capitalMax = inteiroEntre(req.body.capitalMaxReais, capitalMin, 10_000_000, "Capital máximo");
  const resultado = await criarRobos({
    quantidade: inteiroEntre(req.body.quantidade, 1, 200, "Quantidade de perfis"),
    perfis,
    capitalMinCentavos: capitalMin * 100,
    capitalMaxCentavos: capitalMax * 100,
  });
  auditar(req, "ADMIN_ROBOS_CRIADOS", resultado);
  res.status(201).json(resultado);
}));

admin.post("/api/admin/robos/encerrar", asyncRota(async (req, res) => {
  const resultado = await encerrarRobos();
  auditar(req, "ADMIN_ROBOS_ENCERRADOS", resultado);
  res.json(resultado);
}));

admin.post("/api/admin/agentes/ritmo", (req, res) => {
  res.json(configurarAgentes({
    ligados: Boolean(req.body.ligados),
    intervaloMs: inteiroEntre(req.body.intervaloMs, 250, 10_000, "Intervalo"),
    porRodada: inteiroEntre(req.body.porRodada, 1, 50, "Agentes por rodada"),
  }));
});

admin.post("/api/admin/carga", (req, res) => {
  const usuarios = inteiroEntre(req.body.usuarios, 1, 200, "Usuários simultâneos");
  const ordens = inteiroEntre(req.body.ordensPorUsuario, 1, 25, "Ordens por usuário");
  if (!iniciarCarga(usuarios, ordens)) {
    res.status(409).json({ erro: "Já existe um teste de carga em andamento. Aguarde terminar." });
    return;
  }
  auditar(req, "ADMIN_CARGA_DISPARADA", { usuarios, ordensPorUsuario: ordens });
  res.status(202).json({ iniciado: true });
});
