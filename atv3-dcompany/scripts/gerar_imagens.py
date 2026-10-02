"""Gera PNGs coloridos sem dependências, para os clientes de teste."""

import argparse
import struct
import zlib
from pathlib import Path


def gravar_png(caminho, largura, altura, pixels):
    def chunk(tag, dados):
        crc = zlib.crc32(tag + dados) & 0xFFFFFFFF
        return struct.pack(">I", len(dados)) + tag + dados + struct.pack(">I", crc)

    bruto = bytearray()
    for linha in pixels:
        bruto.append(0)
        bruto.extend(linha)
    ihdr = struct.pack(">IIBBBBB", largura, altura, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(bruto), 9)) + chunk(b"IEND", b"")
    caminho.write_bytes(png)


def retangulo(largura, altura, fundo, blocos):
    pixels = [bytearray(fundo * largura) for _ in range(altura)]
    for x0, y0, x1, y1, cor in blocos:
        for y in range(max(0, y0), min(altura, y1)):
            linha = pixels[y]
            for x in range(max(0, x0), min(largura, x1)):
                linha[x * 3 : x * 3 + 3] = bytes(cor)
    return pixels


def gerar(pasta):
    raiz = Path(pasta)
    especificacoes = {
        "cliente1": {
            "casa.png": ((30, 90, 160), [(40, 80, 180, 190, (180, 40, 40)), (150, 30, 280, 170, (240, 200, 40))]),
            "carro.png": ((20, 40, 90), [(30, 90, 290, 170, (20, 90, 200)), (70, 40, 220, 110, (230, 230, 240))]),
        },
        "cliente2": {
            "praia.png": ((70, 170, 230), [(0, 120, 320, 200, (230, 190, 70)), (180, 30, 250, 90, (240, 90, 40))]),
            "floresta.png": ((20, 120, 50), [(40, 70, 110, 190, (10, 70, 20)), (150, 40, 250, 190, (30, 140, 60))]),
        },
    }
    for cliente, imagens in especificacoes.items():
        destino = raiz / cliente
        destino.mkdir(parents=True, exist_ok=True)
        for nome, (fundo, blocos) in imagens.items():
            pixels = retangulo(320, 200, fundo, blocos)
            gravar_png(destino / nome, 320, 200, pixels)
            print(f"gerada {destino / nome}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--saida", default="imagens/clientes")
    args = parser.parse_args()
    gerar(args.saida)
