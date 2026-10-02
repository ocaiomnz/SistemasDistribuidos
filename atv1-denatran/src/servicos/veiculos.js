import { abrirRepositorio, criarTrava } from "../repositorio.js";
import { rpc, subirServico } from "../protocolo.js";
import { ano, arredondar, cpf, placa, texto, valorVeiculo } from "../validacao.js";

export const ALIQUOTA_IPVA = 0.02;

const { estado, salvar } = abrirRepositorio("veiculos", { veiculos: {} });
const trava = criarTrava();

function exigirVeiculo(codigoPlaca) {
  const veiculo = estado.veiculos[codigoPlaca];
  if (!veiculo) {
    throw new Error("Veículo não encontrado");
  }
  return veiculo;
}

async function exigirCondutor(cliente, documento) {
  return rpc(cliente, "denatran/condutores/consultar", { cpf: documento });
}

function criarHandlers(cliente) {
  return {
    ping() {
      return { servico: "veiculos" };
    },

    async emplacar(dados) {
      const codigoPlaca = placa(dados.placa);
      const modelo = texto(dados.modelo, "modelo");
      const valor = valorVeiculo(dados.valor);
      const documento = cpf(dados.cpf);
      const anoEmplacamento =
        dados.ano === undefined || dados.ano === ""
          ? new Date().getFullYear()
          : ano(dados.ano);

      await exigirCondutor(cliente, documento);

      return trava(() => {
        if (estado.veiculos[codigoPlaca]) {
          throw new Error("Veículo já emplacado");
        }
        const veiculo = {
          placa: codigoPlaca,
          modelo,
          valor,
          cpf: documento,
          ano: anoEmplacamento,
        };
        estado.veiculos[codigoPlaca] = veiculo;
        salvar();
        console.log(`[veiculos] emplacado ${codigoPlaca} (${anoEmplacamento})`);
        return { ...veiculo };
      });
    },

    async ipva(dados) {
      const codigoPlaca = placa(dados.placa);
      const veiculo = exigirVeiculo(codigoPlaca);
      const ipva = arredondar(veiculo.valor * ALIQUOTA_IPVA);
      return {
        placa: veiculo.placa,
        valor: veiculo.valor,
        aliquota: ALIQUOTA_IPVA,
        ipva,
      };
    },

    async "por-ano"(dados) {
      const anoConsulta = ano(dados.ano);
      const veiculos = Object.values(estado.veiculos)
        .filter((veiculo) => veiculo.ano === anoConsulta)
        .sort((a, b) => a.placa.localeCompare(b.placa));
      return { ano: anoConsulta, veiculos };
    },

    async consultar(dados) {
      const codigoPlaca = placa(dados.placa);
      return { ...exigirVeiculo(codigoPlaca) };
    },

    async "atualizar-proprietario"(dados) {
      const codigoPlaca = placa(dados.placa);
      const documento = cpf(dados.cpf);
      await exigirCondutor(cliente, documento);
      return trava(() => {
        const veiculo = exigirVeiculo(codigoPlaca);
        veiculo.cpf = documento;
        salvar();
        console.log(`[veiculos] proprietário de ${codigoPlaca} agora é ${documento}`);
        return { ...veiculo };
      });
    },
  };
}

subirServico("veiculos", "denatran/veiculos", criarHandlers).catch((erro) => {
  console.error(erro);
  process.exit(1);
});
