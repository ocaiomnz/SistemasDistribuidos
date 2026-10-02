# DENATRAN — microsserviços com MQTT

Sistema do DENATRAN em três microsserviços, com o Eclipse Mosquitto como barramento. Cada serviço guarda o próprio estado em JSON e conversa com os outros por pedido e resposta no MQTT.

| Serviço | Responsabilidade |
| --- | --- |
| `condutores` | Cadastrar condutor e transferir proprietário |
| `veiculos` | Emplacar, calcular IPVA (2%) e listar veículos de um ano |
| `multas` | Lançar multa e responder as consultas, inclusive o ranking |

A multa guarda o CPF e o nome de quem era o proprietário na hora do lançamento. Uma transferência posterior não reescreve esse histórico.

## Subir e testar

Na pasta `atv1-denatran`:

```bash
docker compose up --build --abort-on-container-exit --exit-code-from demo
```

O contêiner `demo` cadastra condutores, emplaca, calcula IPVA, lança multas, consulta e transfere um veículo. O processo termina com código 0 quando todas as conferências passam. O Compose encerra os serviços em seguida.

Para usar o cliente manualmente, suba só o broker e os três serviços:

```bash
docker compose up --build mosquitto condutores veiculos multas
```

Em outro terminal, na mesma pasta:

```bash
docker compose run --rm demo node src/cliente.js cadastrar-condutor --cpf 12345678901 --nome "Maria Alves"
docker compose run --rm demo node src/cliente.js emplacar --placa BRA2E19 --modelo Onix --valor 68000 --cpf 12345678901 --ano 2024
docker compose run --rm demo node src/cliente.js ipva --placa BRA2E19
docker compose run --rm demo node src/cliente.js multar --ano 2024 --descricao "Excesso de velocidade" --pontuacao 7 --placa BRA2E19
docker compose run --rm demo node src/cliente.js multas-veiculo --placa BRA2E19 --ano 2024
docker compose run --rm demo node src/cliente.js top5
```

O ano do emplacamento é opcional. Sem `--ano`, vale o ano corrente. As consultas de multa pedem o ano porque o enunciado pede o recorte anual. A placa tem 7 caracteres e o CPF, 11 dígitos.

## Tópicos

Pedidos em `denatran/<serviço>/<ação>`. A mensagem leva `correlationId`, `replyTo` e `dados`. A resposta volta em `replyTo` com `ok` e `dados` ou `erro`.

- `denatran/condutores/cadastrar` — `cpf`, `nome`
- `denatran/condutores/transferir` — `placa`, `cpf` do novo dono
- `denatran/veiculos/emplacar` — `placa`, `modelo`, `valor`, `cpf`, `ano` opcional
- `denatran/veiculos/ipva` — `placa`
- `denatran/veiculos/por-ano` — `ano`
- `denatran/multas/lancar` — `ano`, `descricao`, `pontuacao`, `placa`
- `denatran/multas/por-veiculo` — `placa`, `ano`
- `denatran/multas/por-condutor` — `cpf`, `ano`
- `denatran/multas/por-ano` — `ano`
- `denatran/multas/top5`

Há também `consultar` e `atualizar-proprietario`, usados entre os serviços, e `ping`, usado pela demonstração.
