import argparse
from io import BytesIO
from pathlib import Path

from PIL import Image

from comum import EXCHANGE_CONVERTIDAS, FILA_IMAGENS, conectar, desempacotar, empacotar, publicar

FORMATOS = {
    ".png": "PNG",
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".bmp": "BMP",
    ".gif": "GIF",
    ".webp": "WEBP",
}


def converter(nome, conteudo):
    with Image.open(BytesIO(conteudo)) as imagem:
        cinza = imagem.convert("L")
        buffer = BytesIO()
        formato = FORMATOS.get(Path(nome).suffix.lower(), "PNG")
        cinza.save(buffer, format=formato)
        return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description="Servidor de conversão da DCompany")
    parser.add_argument("--id", required=True)
    args = parser.parse_args()

    _conexao, canal = conectar()
    canal.basic_qos(prefetch_count=1)

    def ao_receber(_canal, metodo, _propriedades, corpo):
        try:
            nome, conteudo = desempacotar(corpo)
            convertido = converter(nome, conteudo)
            publicar(canal, EXCHANGE_CONVERTIDAS, "", empacotar(nome, convertido))
            canal.basic_ack(delivery_tag=metodo.delivery_tag)
            print(f"[{args.id}] converteu {nome}", flush=True)
        except Exception as erro:
            print(f"[{args.id}] falha ao converter: {erro}", flush=True)
            canal.basic_nack(delivery_tag=metodo.delivery_tag, requeue=False)

    canal.basic_consume(queue=FILA_IMAGENS, on_message_callback=ao_receber)
    Path("/tmp/ready").write_text(args.id, encoding="utf-8")
    print(f"[{args.id}] consumindo {FILA_IMAGENS}", flush=True)
    canal.start_consuming()


if __name__ == "__main__":
    main()
