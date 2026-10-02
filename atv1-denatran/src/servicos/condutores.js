import { abrirRepositorio, criarTrava } from "../repositorio.js";
import { rpc, subirServico } from "../protocolo.js";
import { cpf, placa, texto } from "../validacao.js";

const { estado, salvar } = abrirRepositorio("condutores", { condutores: {} });
const trava = criarTrava();

function exigirCondutor(documento) {
  const condutor = estado.condutores[documento];
  if (!condutor) {
    throw new Error("Condutor não cadastrado");
  }
  return { ...condutor };
}

function criarHandlers(cliente) {
  return {
    ping() {
      return { servico: "condutores" };
    },

    async cadastrar(dados) {
      const documento = cpf(dados.cpf);
      const nome = texto(dados.nome, "nome");
      return trava(() => {
        if (estado.condutores[documento]) {
          throw new Error("Condutor já cadastrado");
        }
        const condutor = { cpf: documento, nome };
        estado.condutores[documento] = condutor;
        salvar();
        console.log(`[condutores] cadastrado ${documento} (${nome})`);
        return { ...condutor };
      });
    },

    async consultar(dados) {
      const documento = cpf(dados.cpf);
      return exigirCondutor(documento);
    },

    async transferir(dados) {
      const placaVeiculo = placa(dados.placa);
      const novoCpf = cpf(dados.cpf);
      exigirCondutor(novoCpf);
      const veiculo = await rpc(cliente, "denatran/veiculos/atualizar-proprietario", {
        placa: placaVeiculo,
        cpf: novoCpf,
      });
      console.log(`[condutores] transferência ${placaVeiculo} -> ${novoCpf}`);
      return {
        placa: veiculo.placa,
        cpf: veiculo.cpf,
        condutor: exigirCondutor(novoCpf),
      };
    },
  };
}

subirServico("condutores", "denatran/condutores", criarHandlers).catch((erro) => {
  console.error(erro);
  process.exit(1);
});
