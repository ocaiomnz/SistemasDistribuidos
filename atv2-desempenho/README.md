# Desempenho: cliente-servidor e P2P

Quatro formas de transferir o mesmo arquivo, medidas em C:

| Modo | Comportamento |
| --- | --- |
| `serial` | O servidor conclui um download antes de aceitar o próximo |
| `thread` | Uma thread por cliente, todos ao mesmo tempo |
| `pool` | No máximo N clientes ao mesmo tempo (padrão N = 2) |
| `p2p` | Tracker, semeador e pares que republicam peças de 256 KiB |

O cliente do modo cliente-servidor descarta os bytes. O par P2P guarda o arquivo só em memória de arquivo temporário, já desvinculado do disco, para poder servir peças, e o sistema apaga esses dados quando o processo termina. Cada recebimento é conferido com FNV-1a.

A matriz padrão usa arquivos de 5 MB, 50 MB e 500 MB (MB = 1024 × 1024 bytes) e 1, 2 e 4 clientes. Mínimo, médio e máximo são os tempos de conclusão dos clientes da mesma onda.

## Rodar

Na pasta `atv2-desempenho`:

```bash
docker compose up --build
```

Ao terminar, estes arquivos ficam em `resultados/`:

- `relatorio.pdf`
- `resultados.json`
- `resultados.csv`
- `logs/` com a saída dos processos

Uma matriz menor, para um teste rápido:

```bash
docker compose run --rm experimento python3 scripts/experimento.py --tamanhos-mb 5 --clientes 1,2 --grupo "Nome do grupo"
```

O nome do grupo entra na capa do PDF. O valor padrão é um lembrete para preencher antes da entrega.

Os binários também aceitam host e porta (`cliente`, `servidor` e `p2p`), então a mesma medição pode ser repetida com o semeador em uma máquina e os pares em outras. O relatório discute por que, numa máquina só, o loopback não reproduz o ganho clássico do P2P num enlace limitado.
