import fs from "node:fs";
import path from "node:path";

export function abrirRepositorio(nome, estadoInicial) {
  const diretorio = process.env.DATA_DIR || path.join(process.cwd(), "dados");
  fs.mkdirSync(diretorio, { recursive: true });
  const arquivo = path.join(diretorio, `${nome}.json`);

  if (process.env.RESET === "1") {
    fs.rmSync(arquivo, { force: true });
  }

  let estado = structuredClone(estadoInicial);
  if (fs.existsSync(arquivo)) {
    estado = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  }

  function salvar() {
    const temporario = `${arquivo}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify(estado, null, 2));
    fs.renameSync(temporario, arquivo);
  }

  if (!fs.existsSync(arquivo)) {
    salvar();
  }

  return { estado, salvar, arquivo };
}

export function criarTrava() {
  let atual = Promise.resolve();
  return function trava(fn) {
    const resultado = atual.then(fn);
    atual = resultado.then(
      () => {},
      () => {}
    );
    return resultado;
  };
}
