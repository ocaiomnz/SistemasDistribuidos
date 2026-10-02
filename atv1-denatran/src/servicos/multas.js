import { randomUUID } from "node:crypto";
import { abrirRepositorio, criarTrava } from "../repositorio.js";
import { rpc, subirServico } from "../protocolo.js";
import { ano, cpf, inteiro, placa, texto } from "../validacao.js";

const { estado, salvar } = abrirRepositorio("multas", { multas: [] });
const trava = criarTrava();

function resumir(multa) {
  return {
    ano: multa.ano,
    descricao: multa.descricao,
    pontuacao: multa.pontuacao,
    placa: multa.placa,
    condutor: {
      cpf: multa.condutor.cpf,
      nome: multa.condutor.nome,
    },
  };
}

function criarHandlers(cliente) {
  return {
    ping() {
      return { servico: "multas" };
    },

    async lancar(dados) {
      const anoMulta = ano(dados.ano);
      const descricao = texto(dados.descricao, "descricao");
      const pontuacao = inteiro(dados.pontuacao, "pontuacao");
      const codigoPlaca = placa(dados.placa);
      if (pontuacao < 0) {
        throw new Error("Pontuação não pode ser negativa");
      }

      const veiculo = await rpc(cliente, "denatran/veiculos/consultar", { placa: codigoPlaca });
      const condutor = await rpc(cliente, "denatran/condutores/consultar", { cpf: veiculo.cpf });

      return trava(() => {
        const multa = {
          id: randomUUID(),
          ano: anoMulta,
          descricao,
          pontuacao,
          placa: codigoPlaca,
          condutor: { cpf: condutor.cpf, nome: condutor.nome },
        };
        estado.multas.push(multa);
        salvar();
        console.log(`[multas] ${codigoPlaca} ${anoMulta} ${pontuacao} pts (${condutor.nome})`);
        return resumir(multa);
      });
    },

    async "por-veiculo"(dados) {
      const codigoPlaca = placa(dados.placa);
      const anoMulta = ano(dados.ano);
      const multas = estado.multas
        .filter((multa) => multa.placa === codigoPlaca && multa.ano === anoMulta)
        .map(resumir);
      return { placa: codigoPlaca, ano: anoMulta, multas };
    },

    async "por-condutor"(dados) {
      const documento = cpf(dados.cpf);
      const anoMulta = ano(dados.ano);
      const multas = estado.multas
        .filter((multa) => multa.condutor.cpf === documento && multa.ano === anoMulta)
        .map(resumir);
      return { cpf: documento, ano: anoMulta, multas };
    },

    async "por-ano"(dados) {
      const anoMulta = ano(dados.ano);
      const multas = estado.multas.filter((multa) => multa.ano === anoMulta).map(resumir);
      return { ano: anoMulta, multas };
    },

    async top5() {
      const porCondutor = new Map();
      for (const multa of estado.multas) {
        const atual = porCondutor.get(multa.condutor.cpf) || {
          cpf: multa.condutor.cpf,
          nome: multa.condutor.nome,
          pontuacao: 0,
        };
        atual.pontuacao += multa.pontuacao;
        atual.nome = multa.condutor.nome;
        porCondutor.set(multa.condutor.cpf, atual);
      }

      const condutores = [...porCondutor.values()]
        .sort((a, b) => b.pontuacao - a.pontuacao || a.nome.localeCompare(b.nome, "pt-BR"))
        .slice(0, 5)
        .map((condutor, indice) => ({
          posicao: indice + 1,
          cpf: condutor.cpf,
          nome: condutor.nome,
          pontuacao: condutor.pontuacao,
        }));

      return { condutores };
    },
  };
}

subirServico("multas", "denatran/multas", criarHandlers).catch((erro) => {
  console.error(erro);
  process.exit(1);
});
