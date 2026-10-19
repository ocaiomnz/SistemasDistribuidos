import express from "express";
import session from "express-session";
import MySQLStoreFactory from "express-mysql-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opcoesSessao } from "./banco.js";
import { ehFalhaDeInfra } from "./erros.js";
import { registrar, registrarErro } from "./log.js";
import { cabecalhosSeguros, protegerMutacoes } from "./seguranca.js";
import { paginas } from "./rotas/paginas.js";
import { api } from "./rotas/api.js";
import { admin } from "./rotas/admin.js";

const MySQLStore = MySQLStoreFactory(session);
const diretorio = path.dirname(fileURLToPath(import.meta.url));

export function criarApp() {
  const app = express();
  const armazenamento = new MySQLStore({
    ...opcoesSessao(),
    createDatabaseTable: true,
  });

  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(diretorio, "visoes"));
  app.use(cabecalhosSeguros);
  app.use(express.urlencoded({ extended: false, limit: "20kb" }));
  app.use(express.json({ limit: "20kb" }));
  app.use(express.static(path.join(diretorio, "publico"), {
    setHeaders(res) {
      res.set("Cache-Control", "no-store");
    },
  }));
  app.use(session({
    secret: process.env.SESSION_SECRET || "pregao-norte-dev",
    store: armazenamento,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8,
    },
  }));

  app.get("/saude", (_req, res) => {
    res.json({ ok: true, servico: "pregao" });
  });
  app.use(protegerMutacoes);
  app.use(paginas);
  app.use(api);
  app.use(admin);
  app.use((erro, req, res, _next) => {
    if (res.headersSent) return;
    if (erro.type === "entity.parse.failed" || erro.type === "entity.too.large") {
      registrar("VALIDACAO_REJEITADA", { rota: req.originalUrl, motivo: erro.type, usuarioId: req.session?.usuarioId || null });
      res.status(400).json({ erro: "Corpo da requisição inválido ou grande demais." });
      return;
    }
    if (ehFalhaDeInfra(erro)) {
      registrarErro("ERRO_HTTP", erro, { rota: req.originalUrl, metodo: req.method, usuarioId: req.session?.usuarioId || null });
      res.status(503).json({ erro: `Falha interna ao processar; a transação foi desfeita e nada mudou. Detalhe: ${erro.message}` });
      return;
    }
    res.status(erro.status || 400).json({ erro: erro.message });
  });
  return app;
}
