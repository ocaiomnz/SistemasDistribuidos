import argparse
from pathlib import Path

from comum import EXCHANGE_CONVERTIDAS, conectar, desempacotar, fila_armazenamento


def gravar(pasta, nome, conteudo):
    destino = pasta / nome
    temporario = pasta / f".{nome}.tmp"
    temporario.write_bytes(conteudo)
    temporario.replace(destino)


def main():
    parser = argparse.ArgumentParser(description="Servidor de armazenamento da DCompany")
    parser.add_argument("--id", required=True)
    parser.add_argument("--pasta", required=True)
    args = parser.parse_args()

    pasta = Path(args.pasta)
    pasta.mkdir(parents=True, exist_ok=True)
    fila = fila_armazenamento(args.id)

    _conexao, canal = conectar()
    canal.queue_declare(queue=fila, durable=True)
    canal.queue_bind(queue=fila, exchange=EXCHANGE_CONVERTIDAS)
    canal.basic_qos(prefetch_count=1)

    def ao_receber(_canal, metodo, _propriedades, corpo):
        try:
            nome, conteudo = desempacotar(corpo)
            gravar(pasta, nome, conteudo)
            canal.basic_ack(delivery_tag=metodo.delivery_tag)
            print(f"[{args.id}] armazenou {nome}", flush=True)
        except Exception as erro:
            print(f"[{args.id}] falha ao armazenar: {erro}", flush=True)
            canal.basic_nack(delivery_tag=metodo.delivery_tag, requeue=False)

    canal.basic_consume(queue=fila, on_message_callback=ao_receber)
    Path("/tmp/ready").write_text(args.id, encoding="utf-8")
    print(f"[{args.id}] consumindo {fila} e gravando em {pasta}", flush=True)
    canal.start_consuming()


if __name__ == "__main__":
    main()
