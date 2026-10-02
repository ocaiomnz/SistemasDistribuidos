import { conectar, instalarDespacho, rpc, TOPICOS } from "./protocolo.js";

const CAMPOS_NUMERICOS = new Set(["valor", "ano", "pontuacao"]);

export async function criarSessao() {
  const cliente = await conectar("cliente");
  instalarDespacho(cliente);
  return {
    chamar(acao, dados) {
      const topico = TOPICOS[acao];
      if (!topico) {
        throw new Error(`Ação desconhecida: ${acao}. Use: ${Object.keys(TOPICOS).join(", ")}`);
      }
      return rpc(cliente, topico, dados);
    },
    async fechar() {
      await cliente.endAsync();
    },
  };
}

function lerArgumentos(argv) {
  const [acao, ...resto] = argv;
  if (!acao || acao === "--help" || acao === "-h") {
    return { ajuda: true };
  }
  const dados = {};
  for (let i = 0; i < resto.length; i += 2) {
    const chaveBruta = resto[i];
    const valor = resto[i + 1];
    if (!chaveBruta?.startsWith("--") || valor === undefined) {
      throw new Error("Informe os parâmetros como --campo valor");
    }
    const chave = chaveBruta.slice(2);
    dados[chave] = CAMPOS_NUMERICOS.has(chave) ? Number(valor) : valor;
  }
  return { acao, dados };
}

function imprimirAjuda() {
  console.log(`Cliente DENATRAN

Uso:
  node src/cliente.js <ação> [--campo valor]

Ações:
  cadastrar-condutor --cpf CPF --nome NOME
  transferir --placa PLACA --cpf CPF_NOVO_DONO
  emplacar --placa PLACA --modelo MODELO --valor VALOR --cpf CPF [--ano ANO]
  ipva --placa PLACA
  veiculos-por-ano --ano ANO
  multar --ano ANO --descricao TEXTO --pontuacao PONTOS --placa PLACA
  multas-veiculo --placa PLACA --ano ANO
  multas-condutor --cpf CPF --ano ANO
  multas-ano --ano ANO
  top5
`);
}

async function main() {
  const { ajuda, acao, dados } = lerArgumentos(process.argv.slice(2));
  if (ajuda) {
    imprimirAjuda();
    return;
  }
  const sessao = await criarSessao();
  try {
    const resposta = await sessao.chamar(acao, dados);
    console.log(JSON.stringify(resposta, null, 2));
  } finally {
    await sessao.fechar();
  }
}

const executadoDireto = process.argv[1]?.endsWith("cliente.js");
if (executadoDireto) {
  main().catch((erro) => {
    console.error(erro.message);
    process.exit(1);
  });
}
