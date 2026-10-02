import { conectar, instalarDespacho, rpc } from "./protocolo.js";

function afirmar(condicao, mensagem) {
  if (!condicao) {
    throw new Error(mensagem);
  }
}

async function esperarServicos(cliente) {
  const topicos = [
    "denatran/condutores/ping",
    "denatran/veiculos/ping",
    "denatran/multas/ping",
  ];
  const limite = Date.now() + 40000;
  let ultimoErro = null;
  while (Date.now() < limite) {
    try {
      await Promise.all(topicos.map((topico) => rpc(cliente, topico, {}, 2000)));
      console.log("Serviços prontos: condutores, veículos e multas.");
      return;
    } catch (erro) {
      ultimoErro = erro;
      await new Promise((resolver) => setTimeout(resolver, 500));
    }
  }
  throw new Error(`Serviços não responderam: ${ultimoErro?.message || "sem detalhe"}`);
}

async function passo(titulo, fn) {
  const dados = await fn();
  console.log(`\n== ${titulo}`);
  console.log(JSON.stringify(dados, null, 2));
  return dados;
}

async function deveFalhar(titulo, fn) {
  try {
    await fn();
  } catch (erro) {
    console.log(`\n== ${titulo}`);
    console.log(`falhou como esperado: ${erro.message}`);
    return;
  }
  throw new Error(`A operação deveria falhar: ${titulo}`);
}

async function main() {
  const cliente = await conectar("demo");
  instalarDespacho(cliente);
  const chamar = (topico, dados) => rpc(cliente, topico, dados);

  await esperarServicos(cliente);

  await passo("Cadastrar Ana", () =>
    chamar("denatran/condutores/cadastrar", { cpf: "11111111111", nome: "Ana Souza" })
  );
  await passo("Cadastrar Bruno", () =>
    chamar("denatran/condutores/cadastrar", { cpf: "22222222222", nome: "Bruno Lima" })
  );
  await passo("Cadastrar Carla", () =>
    chamar("denatran/condutores/cadastrar", { cpf: "33333333333", nome: "Carla Nunes" })
  );
  await passo("Cadastrar Diego", () =>
    chamar("denatran/condutores/cadastrar", { cpf: "44444444444", nome: "Diego Martins" })
  );
  await passo("Cadastrar Elena", () =>
    chamar("denatran/condutores/cadastrar", { cpf: "55555555555", nome: "Elena Prado" })
  );
  await passo("Cadastrar Fabio", () =>
    chamar("denatran/condutores/cadastrar", { cpf: "66666666666", nome: "Fabio Reis" })
  );

  await deveFalhar("CPF duplicado", () =>
    chamar("denatran/condutores/cadastrar", { cpf: "11111111111", nome: "Outra Ana" })
  );
  await deveFalhar("Emplacar sem condutor", () =>
    chamar("denatran/veiculos/emplacar", {
      placa: "ZZZ9Z99",
      modelo: "Fusca",
      valor: 1000,
      cpf: "99999999999",
      ano: 2024,
    })
  );

  await passo("Emplacar Gol da Ana (2023)", () =>
    chamar("denatran/veiculos/emplacar", {
      placa: "ABC1A11",
      modelo: "Gol",
      valor: 50000,
      cpf: "11111111111",
      ano: 2023,
    })
  );
  await passo("Emplacar Civic do Bruno (2024)", () =>
    chamar("denatran/veiculos/emplacar", {
      placa: "DEF2B22",
      modelo: "Civic",
      valor: 90000,
      cpf: "22222222222",
      ano: 2024,
    })
  );
  await passo("Emplacar Onix da Carla (2024)", () =>
    chamar("denatran/veiculos/emplacar", {
      placa: "GHI3C33",
      modelo: "Onix",
      valor: 70000,
      cpf: "33333333333",
      ano: 2024,
    })
  );
  await passo("Emplacar Fiesta do Diego (2023)", () =>
    chamar("denatran/veiculos/emplacar", {
      placa: "JKL4D44",
      modelo: "Fiesta",
      valor: 40000,
      cpf: "44444444444",
      ano: 2023,
    })
  );
  await passo("Emplacar Mobi da Elena (2024)", () =>
    chamar("denatran/veiculos/emplacar", {
      placa: "MNO5E55",
      modelo: "Mobi",
      valor: 45000,
      cpf: "55555555555",
      ano: 2024,
    })
  );

  const ipva = await passo("IPVA do Gol (2%)", () =>
    chamar("denatran/veiculos/ipva", { placa: "ABC1A11" })
  );
  afirmar(ipva.aliquota === 0.02, "Alíquota deveria ser 2%");
  afirmar(ipva.ipva === 1000, `IPVA esperado 1000, obtido ${ipva.ipva}`);

  const de2024 = await passo("Veículos emplacados em 2024", () =>
    chamar("denatran/veiculos/por-ano", { ano: 2024 })
  );
  afirmar(de2024.veiculos.map((v) => v.placa).join() === "DEF2B22,GHI3C33,MNO5E55", "Placas de 2024 divergentes");

  await passo("Multa da Ana em 2024", () =>
    chamar("denatran/multas/lancar", {
      ano: 2024,
      descricao: "Excesso de velocidade",
      pontuacao: 7,
      placa: "ABC1A11",
    })
  );
  await passo("Segunda multa da Ana em 2024", () =>
    chamar("denatran/multas/lancar", {
      ano: 2024,
      descricao: "Estacionamento irregular",
      pontuacao: 3,
      placa: "ABC1A11",
    })
  );
  await passo("Multa do Bruno em 2024", () =>
    chamar("denatran/multas/lancar", {
      ano: 2024,
      descricao: "Avanço de sinal",
      pontuacao: 5,
      placa: "DEF2B22",
    })
  );
  await passo("Multa do Bruno em 2023", () =>
    chamar("denatran/multas/lancar", {
      ano: 2023,
      descricao: "Farol apagado",
      pontuacao: 4,
      placa: "DEF2B22",
    })
  );
  await passo("Multa da Carla em 2024", () =>
    chamar("denatran/multas/lancar", {
      ano: 2024,
      descricao: "Ultrapassagem proibida",
      pontuacao: 8,
      placa: "GHI3C33",
    })
  );
  await passo("Multa do Diego em 2024", () =>
    chamar("denatran/multas/lancar", {
      ano: 2024,
      descricao: "Cinto de segurança",
      pontuacao: 1,
      placa: "JKL4D44",
    })
  );
  await passo("Multa da Elena em 2024", () =>
    chamar("denatran/multas/lancar", {
      ano: 2024,
      descricao: "Celular ao volante",
      pontuacao: 6,
      placa: "MNO5E55",
    })
  );

  const multasGol = await passo("Multas do Gol em 2024, com o condutor", () =>
    chamar("denatran/multas/por-veiculo", { placa: "ABC1A11", ano: 2024 })
  );
  afirmar(multasGol.multas.length === 2, "O Gol deveria ter 2 multas em 2024");
  afirmar(
    multasGol.multas.every((multa) => multa.condutor.nome === "Ana Souza" && multa.condutor.cpf === "11111111111"),
    "As multas do Gol deveriam apontar para Ana"
  );

  const multasBruno = await passo("Multas do Bruno em 2024", () =>
    chamar("denatran/multas/por-condutor", { cpf: "22222222222", ano: 2024 })
  );
  afirmar(multasBruno.multas.length === 1, "Bruno deveria ter 1 multa em 2024");
  afirmar(multasBruno.multas[0].pontuacao === 5, "Pontuação do Bruno em 2024 divergente");

  const multas2023 = await passo("Multas lançadas em 2023", () =>
    chamar("denatran/multas/por-ano", { ano: 2023 })
  );
  afirmar(multas2023.multas.length === 1, "Deveria existir 1 multa em 2023");

  const ranking = await passo("Cinco condutores com maior pontuação", () =>
    chamar("denatran/multas/top5", {})
  );
  afirmar(
    ranking.condutores.map((c) => `${c.nome}:${c.pontuacao}`).join(" | ") ===
      "Ana Souza:10 | Bruno Lima:9 | Carla Nunes:8 | Elena Prado:6 | Diego Martins:1",
    `Ranking divergente: ${JSON.stringify(ranking.condutores)}`
  );

  await passo("Transferir o Gol da Ana para o Fabio", () =>
    chamar("denatran/condutores/transferir", { placa: "ABC1A11", cpf: "66666666666" })
  );

  await passo("Nova multa do Gol fica com o Fabio", () =>
    chamar("denatran/multas/lancar", {
      ano: 2025,
      descricao: "Rodízio",
      pontuacao: 2,
      placa: "ABC1A11",
    })
  );

  const historico = await passo("Multas antigas do Gol continuam com a Ana", () =>
    chamar("denatran/multas/por-veiculo", { placa: "ABC1A11", ano: 2024 })
  );
  afirmar(historico.multas.every((multa) => multa.condutor.nome === "Ana Souza"), "Histórico alterado");

  const multaNova = await passo("Multa de 2025 do Gol", () =>
    chamar("denatran/multas/por-veiculo", { placa: "ABC1A11", ano: 2025 })
  );
  afirmar(multaNova.multas[0].condutor.nome === "Fabio Reis", "A multa nova deveria ser do Fabio");

  await deveFalhar("Transferir para CPF inexistente", () =>
    chamar("denatran/condutores/transferir", { placa: "ABC1A11", cpf: "99999999999" })
  );
  await deveFalhar("Multar placa inexistente", () =>
    chamar("denatran/multas/lancar", {
      ano: 2024,
      descricao: "Teste",
      pontuacao: 1,
      placa: "XXX0X00",
    })
  );

  console.log("\nDemonstração concluída com sucesso.");
  await cliente.endAsync();
}

main().catch((erro) => {
  console.error(`\nFalha na demonstração: ${erro.message}`);
  process.exit(1);
});
