import argparse
from pathlib import Path

from comum import FILA_IMAGENS, conectar, empacotar, publicar

EXTENSOES = {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp"}


def enviar_pasta(canal, pasta, identificador):
    arquivos = sorted(
        caminho
        for caminho in Path(pasta).iterdir()
        if caminho.is_file() and caminho.suffix.lower() in EXTENSOES
    )
    if not arquivos:
        raise SystemExit(f"Nenhuma imagem em {pasta}")
    for caminho in arquivos:
        publicar(canal, "", FILA_IMAGENS, empacotar(caminho.name, caminho.read_bytes()))
        print(f"[{identificador}] enviou {caminho.name}", flush=True)
    return len(arquivos)


def main():
    parser = argparse.ArgumentParser(description="Cliente produtor da DCompany")
    parser.add_argument("--id", required=True)
    parser.add_argument("--pasta", required=True)
    args = parser.parse_args()

    _conexao, canal = conectar()
    total = enviar_pasta(canal, args.pasta, args.id)
    print(f"[{args.id}] {total} imagem(ns) publicada(s).", flush=True)


if __name__ == "__main__":
    main()
