"""Confere se os dois servidores guardaram as mesmas imagens, em tons de cinza e com o nome original."""

import hashlib
import sys
from pathlib import Path

from PIL import Image

EXTENSOES = {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp"}
ORIGINAIS = Path("/clientes")
ARMAZENAMENTO = Path("/armazenamento")
SERVIDORES = ("servidor1", "servidor2")


def listar_originais():
    arquivos = []
    for pasta in sorted(ORIGINAIS.iterdir()):
        if not pasta.is_dir():
            continue
        for caminho in sorted(pasta.iterdir()):
            if caminho.is_file() and caminho.suffix.lower() in EXTENSOES:
                arquivos.append(caminho)
    return arquivos


def sha256(caminho):
    return hashlib.sha256(caminho.read_bytes()).hexdigest()


def main():
    originais = listar_originais()
    if not originais:
        print("Nenhuma imagem original encontrada.")
        return 1

    falhas = []
    for original in originais:
        hashes = []
        with Image.open(original) as imagem_original:
            tamanho_original = imagem_original.size
        for servidor in SERVIDORES:
            copias = list((ARMAZENAMENTO / servidor).glob(original.name))
            if len(copias) != 1:
                falhas.append(f"{servidor} não tem exatamente uma cópia de {original.name}")
                continue
            copia = copias[0]
            if copia.name != original.name:
                falhas.append(f"Nome divergente: {copia.name}")
            with Image.open(copia) as imagem:
                if imagem.mode != "L":
                    falhas.append(f"{servidor}/{copia.name} não está em tons de cinza (modo {imagem.mode})")
                if imagem.size != tamanho_original:
                    falhas.append(f"{servidor}/{copia.name} mudou de tamanho")
            if sha256(copia) == sha256(original):
                falhas.append(f"{servidor}/{copia.name} ficou idêntica à original")
            hashes.append(sha256(copia))
        if len(hashes) == 2 and hashes[0] != hashes[1]:
            falhas.append(f"{original.name} difere entre os servidores de armazenamento")
        else:
            print(f"ok {original.name} nos dois servidores, em escala de cinza")

    if falhas:
        print("Falhas:")
        for falha in falhas:
            print(f"- {falha}")
        return 1

    print(f"Armazenamento redundante conferido: {len(originais)} imagem(ns).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
