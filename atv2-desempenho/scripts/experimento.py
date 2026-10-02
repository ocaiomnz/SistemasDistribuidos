#!/usr/bin/env python3
"""Executa a matriz de experimentos e grava JSON, CSV e o PDF."""

import argparse
import csv
import json
import os
import platform
import queue
import re
import signal
import statistics
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from relatorio import gerar_pdf

RAIZ = Path(__file__).resolve().parents[1]
BIN = RAIZ / "bin"
PADRAO = re.compile(r"TEMPO_MS (\d+) BYTES (\d+) FNV ([0-9a-fA-F]+)")
ROTULOS = {
    "serial": "CS serial",
    "thread": "CS threads",
    "pool": "CS pool",
    "p2p": "P2P",
}


def encerrar(proc):
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        proc.wait(timeout=5)


class Processos:
    def __init__(self):
        self.procs = []
        self.arquivos = []

    def abrir(self, cmd, **kwargs):
        proc = subprocess.Popen(cmd, start_new_session=True, **kwargs)
        self.procs.append(proc)
        return proc

    def arquivo(self, caminho):
        handle = open(caminho, "w", encoding="utf-8")
        self.arquivos.append(handle)
        return handle

    def fechar(self):
        for proc in self.procs:
            encerrar(proc)
        for handle in self.arquivos:
            handle.close()
        self.procs.clear()
        self.arquivos.clear()


def esperar_porta(porta, timeout=20):
    import socket

    limite = time.time() + timeout
    while time.time() < limite:
        with socket.socket() as sock:
            sock.settimeout(0.2)
            if sock.connect_ex(("127.0.0.1", porta)) == 0:
                return
        time.sleep(0.05)
    raise TimeoutError(f"Porta {porta} não abriu")


def esperar_fnv(caminho, timeout=20):
    limite = time.time() + timeout
    while time.time() < limite:
        if caminho.exists():
            for linha in caminho.read_text(encoding="utf-8", errors="replace").splitlines():
                if linha.startswith("FNV "):
                    return int(linha.split()[1], 16)
        time.sleep(0.05)
    texto = caminho.read_text(encoding="utf-8", errors="replace") if caminho.exists() else ""
    raise TimeoutError(f"FNV ausente em {caminho}:\n{texto[-2000:]}")


def ler_linha(proc, timeout):
    caixa = queue.Queue()

    def leitor():
        try:
            caixa.put(proc.stdout.readline())
        except Exception as erro:
            caixa.put(erro)

    threading.Thread(target=leitor, daemon=True).start()
    try:
        item = caixa.get(timeout=timeout)
    except queue.Empty as erro:
        raise TimeoutError("Tempo esgotado aguardando o fim da transferência") from erro
    if isinstance(item, Exception):
        raise item
    return item


def interpretar(texto, tamanho, fnv_esperado):
    encontrado = PADRAO.search(texto or "")
    if not encontrado:
        raise RuntimeError(f"Saída sem tempo de conclusão:\n{texto}")
    milissegundos = int(encontrado.group(1))
    nbytes = int(encontrado.group(2))
    fnv = int(encontrado.group(3), 16)
    if nbytes != tamanho or fnv != fnv_esperado:
        raise RuntimeError(
            f"Integridade divergente: bytes {nbytes}/{tamanho} fnv {fnv:08x}/{fnv_esperado:08x}"
        )
    return milissegundos


def resumo(arquitetura, pool, tamanho, clientes, tempos):
    return {
        "arquitetura": arquitetura,
        "rotulo": f"{ROTULOS[arquitetura]} (N={pool})" if arquitetura == "pool" else ROTULOS[arquitetura],
        "tamanho_bytes": tamanho,
        "tamanho_mb": tamanho / (1024 * 1024),
        "clientes": clientes,
        "tempos_ms": tempos,
        "min_ms": min(tempos),
        "medio_ms": statistics.mean(tempos),
        "max_ms": max(tempos),
    }


def gerar_arquivo(pasta, tamanho):
    destino = pasta / f"carga-{tamanho}.bin"
    if destino.exists() and destino.stat().st_size == tamanho:
        return destino
    print(f"Gerando {destino.name} ({tamanho} bytes)", flush=True)
    falta = tamanho
    with destino.open("wb") as saida:
        while falta:
            bloco = os.urandom(min(falta, 1024 * 1024))
            saida.write(bloco)
            falta -= len(bloco)
    return destino


def cauda(caminho):
    if not caminho.exists():
        return ""
    return caminho.read_text(encoding="utf-8", errors="replace")[-4000:]


def executar_cs(modo, arquivo, tamanho, nclientes, pool, porta, logs, timeout):
    ctx = Processos()
    log = logs / f"cs-{modo}-{tamanho}-{nclientes}.log"
    try:
        err = ctx.arquivo(log)
        ctx.abrir(
            [str(BIN / "servidor"), str(porta), str(arquivo), modo, str(pool)],
            stdout=subprocess.DEVNULL,
            stderr=err,
        )
        fnv = esperar_fnv(log)
        esperar_porta(porta)
        clientes = []
        for indice in range(nclientes):
            clientes.append(
                ctx.abrir(
                    [str(BIN / "cliente"), "127.0.0.1", str(porta)],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
            )
        tempos = []
        for cliente in clientes:
            saida, _ = cliente.communicate(timeout=timeout)
            if cliente.returncode != 0:
                raise RuntimeError(f"Cliente falhou:\n{saida}\n{cauda(log)}")
            tempos.append(interpretar(saida, tamanho, fnv))
        return tempos
    except Exception:
        print(cauda(log), file=sys.stderr)
        raise
    finally:
        ctx.fechar()


def executar_p2p(arquivo, tamanho, nclientes, porta_tracker, porta_seeder, logs, timeout):
    ctx = Processos()
    log_tracker = logs / f"p2p-tracker-{tamanho}-{nclientes}.log"
    log_seeder = logs / f"p2p-seeder-{tamanho}-{nclientes}.log"
    try:
        ctx.abrir(
            [str(BIN / "p2p"), "tracker", str(porta_tracker)],
            stdout=subprocess.DEVNULL,
            stderr=ctx.arquivo(log_tracker),
        )
        esperar_porta(porta_tracker)
        ctx.abrir(
            [str(BIN / "p2p"), "seeder", "127.0.0.1", str(porta_tracker), str(porta_seeder), "semeador", str(arquivo)],
            stdout=subprocess.DEVNULL,
            stderr=ctx.arquivo(log_seeder),
        )
        fnv = esperar_fnv(log_seeder)
        esperar_porta(porta_seeder)
        pares = []
        for indice in range(nclientes):
            log_par = logs / f"p2p-par{indice}-{tamanho}-{nclientes}.log"
            pares.append(
                ctx.abrir(
                    [str(BIN / "p2p"), "peer", "127.0.0.1", str(porta_tracker), str(porta_seeder + 1 + indice), f"par{indice}"],
                    stdout=subprocess.PIPE,
                    stderr=ctx.arquivo(log_par),
                    text=True,
                )
            )
        tempos = []
        for indice, par in enumerate(pares):
            try:
                linha = ler_linha(par, timeout)
            except TimeoutError:
                log_par = logs / f"p2p-par{indice}-{tamanho}-{nclientes}.log"
                raise RuntimeError(f"Par {indice} não terminou\n{cauda(log_par)}\n{cauda(log_seeder)}") from None
            if not linha:
                log_par = logs / f"p2p-par{indice}-{tamanho}-{nclientes}.log"
                raise RuntimeError(f"Par {indice} encerrou sem medida\n{cauda(log_par)}")
            tempos.append(interpretar(linha, tamanho, fnv))
        return tempos
    except Exception:
        print(cauda(log_seeder), file=sys.stderr)
        print(cauda(log_tracker), file=sys.stderr)
        raise
    finally:
        ctx.fechar()


def main():
    parser = argparse.ArgumentParser(description="Experimentos de transferência cliente-servidor e P2P")
    parser.add_argument("--tamanhos-mb", default="5,50,500")
    parser.add_argument("--clientes", default="1,2,4")
    parser.add_argument("--pool", type=int, default=2)
    parser.add_argument("--grupo", default="Preencher os nomes dos integrantes")
    parser.add_argument("--saida", default=str(RAIZ / "resultados"))
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()

    tamanhos = [int(item) * 1024 * 1024 for item in args.tamanhos_mb.split(",") if item]
    quantidades = [int(item) for item in args.clientes.split(",") if item]
    saida = Path(args.saida)
    logs = saida / "logs"
    cargas = Path("/tmp/atv2-cargas")
    saida.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    cargas.mkdir(parents=True, exist_ok=True)

    experimentos = []
    for tamanho in tamanhos:
        arquivo = gerar_arquivo(cargas, tamanho)
        for quantidade in quantidades:
            for modo in ("serial", "thread", "pool", "p2p"):
                print(f"=== {modo} | {tamanho // (1024 * 1024)} MB | {quantidade} cliente(s)", flush=True)
                inicio = time.perf_counter()
                if modo == "p2p":
                    tempos = executar_p2p(arquivo, tamanho, quantidade, 18100, 18200, logs, args.timeout)
                else:
                    tempos = executar_cs(modo, arquivo, tamanho, quantidade, args.pool, 18000, logs, args.timeout)
                item = resumo(modo, args.pool, tamanho, quantidade, tempos)
                experimentos.append(item)
                print(
                    f"    min {item['min_ms']:.0f} ms | médio {item['medio_ms']:.0f} ms | max {item['max_ms']:.0f} ms "
                    f"({time.perf_counter() - inicio:.1f} s)",
                    flush=True,
                )
                time.sleep(0.3)

    dados = {
        "grupo": args.grupo,
        "quando": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "ambiente": {
            "sistema": platform.platform(),
            "cpus": os.cpu_count(),
            "python": platform.python_version(),
        },
        "pool_n": args.pool,
        "peca_bytes": 256 * 1024,
        "observacao": (
            "Mínimo, médio e máximo são calculados sobre os tempos de conclusão dos clientes "
            "da mesma execução. O arquivo é medido em bytes de 1024 × 1024 por MB."
        ),
        "experimentos": experimentos,
    }
    (saida / "resultados.json").write_text(json.dumps(dados, indent=2, ensure_ascii=False), encoding="utf-8")
    with (saida / "resultados.csv").open("w", newline="", encoding="utf-8") as csv_saida:
        escritor = csv.writer(csv_saida)
        escritor.writerow(["arquitetura", "tamanho_mb", "clientes", "min_ms", "medio_ms", "max_ms"])
        for item in experimentos:
            escritor.writerow(
                [
                    item["rotulo"],
                    f"{item['tamanho_mb']:.0f}",
                    item["clientes"],
                    f"{item['min_ms']:.3f}",
                    f"{item['medio_ms']:.3f}",
                    f"{item['max_ms']:.3f}",
                ]
            )
    pdf = saida / "relatorio.pdf"
    gerar_pdf(pdf, dados)
    print(f"Relatório em {pdf}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as erro:
        print(f"Falha no experimento: {erro}", file=sys.stderr)
        sys.exit(1)
