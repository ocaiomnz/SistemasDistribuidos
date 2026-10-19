import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../banco.js";
import { registrar } from "../log.js";
import { anotarFalhaLogin, exigirAdmin, limparFalhasLogin, segundosDeBloqueio } from "../seguranca.js";
import { asyncRota, exigirLogin } from "../util.js";

export const paginas = Router();

function abrirSessao(req, usuario) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((erro) => {
      if (erro) {
        reject(erro);
        return;
      }
      req.session.usuarioId = usuario.id;
      req.session.nome = usuario.nome;
      req.session.papel = usuario.papel;
      req.session.save((falha) => (falha ? reject(falha) : resolve()));
    });
  });
}

function dadosDaPagina(req, aba) {
  return { nome: req.session.nome, papel: req.session.papel || "investidor", aba };
}

paginas.get("/", (req, res) => {
  res.redirect(req.session.usuarioId ? "/pregao" : "/entrar");
});

paginas.get("/entrar", (req, res) => {
  if (req.session.usuarioId) {
    res.redirect("/pregao");
    return;
  }
  res.render("entrar", { erro: null });
});

paginas.post("/entrar", asyncRota(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase().slice(0, 120);
  const senha = String(req.body.senha || "").slice(0, 200);
  const espera = segundosDeBloqueio(req, email);
  if (espera > 0) {
    registrar("LOGIN_BLOQUEADO", { email, ip: req.ip, segundosRestantes: espera });
    res.status(429).render("entrar", {
      erro: `Muitas tentativas erradas para este e-mail. Aguarde ${espera}s e tente de novo.`,
    });
    return;
  }
  const [linhas] = await pool.query(
    "SELECT id, nome, senha_hash, agente, papel FROM usuarios WHERE email = ?",
    [email]
  );
  const usuario = linhas[0];
  const senhaOk = usuario && !usuario.agente && await bcrypt.compare(senha, usuario.senha_hash);
  if (!senhaOk) {
    const falhas = anotarFalhaLogin(req, email);
    registrar("LOGIN_FALHOU", { email, ip: req.ip, falhas, motivo: usuario?.agente ? "conta de agente" : "credenciais" });
    res.status(401).render("entrar", { erro: "E-mail ou senha não conferem. Corrija os campos ou abra uma conta." });
    return;
  }
  limparFalhasLogin(req, email);
  await abrirSessao(req, usuario);
  registrar("LOGIN_OK", { usuarioId: usuario.id, papel: usuario.papel, ip: req.ip });
  res.redirect("/pregao");
}));

paginas.get("/cadastro", (_req, res) => {
  res.render("cadastro", { erro: null });
});

paginas.post("/cadastro", asyncRota(async (req, res) => {
  const nome = String(req.body.nome || "").trim().slice(0, 80);
  const email = String(req.body.email || "").trim().toLowerCase().slice(0, 120);
  const senha = String(req.body.senha || "");
  if (nome.length < 2 || !/^[^\s@]+@[^\s@]+$/.test(email) || senha.length < 4 || senha.length > 200) {
    res.status(400).render("cadastro", { erro: "Preencha nome, e-mail válido e senha com ao menos 4 caracteres" });
    return;
  }
  const capital = Number(process.env.CAPITAL_INICIAL_CENTAVOS || 10_000_000);
  try {
    const senhaHash = await bcrypt.hash(senha, 10);
    const [insercao] = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, saldo_centavos, capital_inicial_centavos, agente)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [nome, email, senhaHash, capital, capital]
    );
    await abrirSessao(req, { id: insercao.insertId, nome, papel: "investidor" });
    registrar("CADASTRO_OK", { usuarioId: insercao.insertId, ip: req.ip });
    res.redirect("/pregao");
  } catch (erro) {
    const mensagem = erro.code === "ER_DUP_ENTRY" ? "Este e-mail já está cadastrado" : "Não foi possível cadastrar";
    res.status(400).render("cadastro", { erro: mensagem });
  }
}));

paginas.post("/sair", (req, res) => {
  const usuarioId = req.session.usuarioId;
  req.session.destroy(() => {
    if (usuarioId) registrar("LOGOUT", { usuarioId });
    res.redirect("/entrar");
  });
});

paginas.get("/pregao", exigirLogin, (req, res) => {
  res.render("pregao", dadosDaPagina(req, "pregao"));
});

paginas.get("/logs", exigirLogin, exigirAdmin, (req, res) => {
  res.render("logs", dadosDaPagina(req, "logs"));
});

paginas.get("/mundo", exigirLogin, exigirAdmin, (req, res) => {
  res.render("mundo", dadosDaPagina(req, "mundo"));
});

paginas.get("/caos", exigirLogin, exigirAdmin, (req, res) => {
  res.render("caos", dadosDaPagina(req, "caos"));
});

paginas.get("/admin", exigirLogin, exigirAdmin, (req, res) => {
  res.render("admin", dadosDaPagina(req, "admin"));
});
