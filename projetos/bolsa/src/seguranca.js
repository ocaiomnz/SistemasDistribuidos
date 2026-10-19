import { registrar } from "./log.js";

const LIMITE_FALHAS_LOGIN = 5;
const JANELA_LOGIN_MS = 5 * 60 * 1000;
const BLOQUEIO_LOGIN_MS = 60 * 1000;
const LIMITE_ORDENS_POR_SEGUNDO = 30;

const tentativasLogin = new Map();
const ordensRecentes = new Map();

export function cabecalhosSeguros(_req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
  });
  next();
}

export function protegerMutacoes(req, res, next) {
  const mutacao = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  if (!mutacao || !req.originalUrl.startsWith("/api")) {
    next();
    return;
  }
  if (req.get("x-pregao") === "1") {
    next();
    return;
  }
  registrar("CSRF_BLOQUEADO", {
    usuarioId: req.session?.usuarioId || null,
    rota: req.originalUrl,
    metodo: req.method,
    ip: req.ip,
  });
  res.status(403).json({ erro: "Requisição sem o cabeçalho de proteção. Envie a operação pelo próprio Home Broker." });
}

export function exigirAdmin(req, res, next) {
  if (req.session.papel === "admin") {
    next();
    return;
  }
  registrar("ACESSO_NEGADO", {
    usuarioId: req.session.usuarioId || null,
    rota: req.originalUrl,
    motivo: "perfil sem permissão de ADMIN",
    ip: req.ip,
  });
  if (req.originalUrl.startsWith("/api")) {
    res.status(403).json({ erro: "Recurso restrito ao perfil ADMIN." });
    return;
  }
  res.status(403).render("proibido", {
    nome: req.session.nome,
    papel: req.session.papel || "investidor",
    aba: "",
  });
}

function chaveLogin(req, email) {
  return `${req.ip}|${email}`;
}

export function segundosDeBloqueio(req, email) {
  const registro = tentativasLogin.get(chaveLogin(req, email));
  if (!registro?.bloqueadoAte) return 0;
  const restante = registro.bloqueadoAte - Date.now();
  if (restante <= 0) {
    tentativasLogin.delete(chaveLogin(req, email));
    return 0;
  }
  return Math.ceil(restante / 1000);
}

export function anotarFalhaLogin(req, email) {
  const chave = chaveLogin(req, email);
  const agora = Date.now();
  const registro = tentativasLogin.get(chave);
  const atual = !registro || agora - registro.primeira > JANELA_LOGIN_MS
    ? { falhas: 0, primeira: agora, bloqueadoAte: 0 }
    : registro;
  atual.falhas += 1;
  if (atual.falhas >= LIMITE_FALHAS_LOGIN) {
    atual.bloqueadoAte = agora + BLOQUEIO_LOGIN_MS;
    registrar("LOGIN_BLOQUEADO", { email, ip: req.ip, falhas: atual.falhas, segundos: BLOQUEIO_LOGIN_MS / 1000 });
  }
  tentativasLogin.set(chave, atual);
  return atual.falhas;
}

export function limparFalhasLogin(req, email) {
  tentativasLogin.delete(chaveLogin(req, email));
}

export function limitarOrdens(req, res, next) {
  const usuarioId = req.session.usuarioId;
  const agora = Date.now();
  const lista = (ordensRecentes.get(usuarioId) || []).filter((instante) => agora - instante < 1000);
  if (lista.length >= LIMITE_ORDENS_POR_SEGUNDO) {
    registrar("LIMITE_EXCEDIDO", { usuarioId, rota: req.originalUrl, limitePorSegundo: LIMITE_ORDENS_POR_SEGUNDO });
    res.status(429).json({ erro: `Muitas ordens em sequência. O limite é ${LIMITE_ORDENS_POR_SEGUNDO} por segundo.` });
    return;
  }
  lista.push(agora);
  ordensRecentes.set(usuarioId, lista);
  next();
}
