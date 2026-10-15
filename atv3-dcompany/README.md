# DCompany — conversão de imagens com RabbitMQ

Dois clientes publicam imagens na fila `dcompany.imagens`. Dois conversores competem por essa fila, passam a imagem para tons de cinza e republicam o resultado, com o mesmo nome de arquivo, no exchange fanout `dcompany.convertidas`. Cada servidor de armazenamento tem a própria fila ligada a esse exchange, então os dois gravam todas as imagens.

```
cliente1 ──┐
           ├──> fila dcompany.imagens ──> conversor1 ──┐
cliente2 ──┘                          └─> conversor2 ──┤
                                                       v
                                          exchange fanout
                                           ├──> armazenamento servidor1
                                           └──> armazenamento servidor2
```

## Subir e testar

Na pasta `atv3-dcompany`:

```powershell
python scripts/gerar_imagens.py
docker compose up -d --build --wait rabbitmq conversor1 conversor2 armazenamento1 armazenamento2
docker compose --profile teste run --rm --build cliente1
docker compose --profile teste run --rm --build cliente2
docker compose --profile teste run --rm --build verificador
docker compose down
```

No bash, a mesma sequência:

```bash
python3 scripts/gerar_imagens.py
docker compose up -d --build --wait rabbitmq conversor1 conversor2 armazenamento1 armazenamento2
docker compose --profile teste run --rm --build cliente1
docker compose --profile teste run --rm --build cliente2
docker compose --profile teste run --rm --build verificador
docker compose down
```

O gerador cria `imagens/clientes/cliente1` e `imagens/clientes/cliente2`. Depois do teste, as cópias em cinza ficam em:

- `imagens/armazenamento/servidor1`
- `imagens/armazenamento/servidor2`

Os nomes são os mesmos dos arquivos originais (`casa.png`, `carro.png`, `praia.png`, `floresta.png`). O verificador confere o modo cinza, o tamanho e se os dois servidores receberam bytes idênticos.

O painel do RabbitMQ fica em `http://localhost:15672` (usuário e senha `dcompany`).

Para acrescentar um conversor ou um armazenamento, duplique o serviço no `docker-compose.yml`. O conversor usa a mesma fila. O armazenamento precisa de outro `--id` e de outra pasta, para declarar a própria fila no exchange fanout.
