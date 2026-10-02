"""Gera o relatório em PDF a partir do JSON dos experimentos."""

from collections import defaultdict
from pathlib import Path

from fpdf import FPDF

FONTE = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONTE_NEGRITO = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def segundos(ms):
    return f"{ms / 1000:.3f}"


class Relatorio(FPDF):
    def footer(self):
        self.set_y(-12)
        self.set_font("DejaVu", "", 8)
        self.cell(0, 8, f"{self.page_no()}", align="C")


def paragrafo(pdf, texto, tamanho=11, estilo=""):
    pdf.set_font("DejaVu", estilo, tamanho)
    pdf.multi_cell(0, 6, texto)
    pdf.ln(2)


def titulo(pdf, texto):
    pdf.ln(2)
    pdf.set_font("DejaVu", "B", 14)
    pdf.multi_cell(0, 8, texto)
    pdf.ln(1)


def buscar(dados, arquitetura, tamanho, clientes):
    for item in dados["experimentos"]:
        if item["arquitetura"] == arquitetura and item["tamanho_bytes"] == tamanho and item["clientes"] == clientes:
            return item
    return None


def tabela(pdf, experimentos):
    larguras = [46, 24, 36, 37, 37]
    cabecalho = ["Arquitetura", "Clientes", "Mínimo (s)", "Médio (s)", "Máximo (s)"]
    pdf.set_font("DejaVu", "B", 9)
    for texto, largura in zip(cabecalho, larguras):
        pdf.cell(largura, 7, texto, border=1, align="C")
    pdf.ln(7)
    pdf.set_font("DejaVu", "", 9)
    for item in experimentos:
        valores = [
            item["rotulo"],
            str(item["clientes"]),
            segundos(item["min_ms"]),
            segundos(item["medio_ms"]),
            segundos(item["max_ms"]),
        ]
        for texto, largura in zip(valores, larguras):
            pdf.cell(largura, 7, texto, border=1, align="C")
        pdf.ln(7)
    pdf.ln(3)


def barras(pdf, itens):
    maximo = max(valor for _, valor in itens) or 1
    for rotulo, valor in itens:
        pdf.set_font("DejaVu", "", 9)
        pdf.cell(42, 6, rotulo)
        x = pdf.get_x()
        y = pdf.get_y() + 1
        pdf.set_fill_color(33, 92, 142)
        pdf.rect(x, y, 100 * (valor / maximo), 4, style="F")
        pdf.set_xy(x + 104, y - 1)
        pdf.cell(30, 6, f"{segundos(valor)} s", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)


def discutir(pdf, dados):
    por_tamanho = defaultdict(list)
    for item in dados["experimentos"]:
        por_tamanho[item["tamanho_bytes"]].append(item)

    for tamanho in sorted(por_tamanho):
        itens = por_tamanho[tamanho]
        mb = itens[0]["tamanho_mb"]
        maior_n = max(item["clientes"] for item in itens)
        serial = buscar(dados, "serial", tamanho, maior_n)
        thread = buscar(dados, "thread", tamanho, maior_n)
        pool = buscar(dados, "pool", tamanho, maior_n)
        p2p = buscar(dados, "p2p", tamanho, maior_n)
        if not all([serial, thread, pool, p2p]):
            continue
        titulo(pdf, f"Leitura dos resultados — {mb:.0f} MB")
        paragrafo(
            pdf,
            f"Com {mb:.0f} MB e {maior_n} clientes, o tempo máximo foi {segundos(serial['max_ms'])} s "
            f"no modo serial, {segundos(thread['max_ms'])} s com uma thread por cliente, "
            f"{segundos(pool['max_ms'])} s no pool de {dados['pool_n']} e "
            f"{segundos(p2p['max_ms'])} s no P2P. "
            f"Os mínimos foram, na mesma ordem, {segundos(serial['min_ms'])} s, "
            f"{segundos(thread['min_ms'])} s, {segundos(pool['min_ms'])} s e {segundos(p2p['min_ms'])} s.",
        )
        if serial["clientes"] > 1 and serial["max_ms"] > serial["min_ms"] * 1.3:
            paragrafo(
                pdf,
                "No modo serial a distância entre o mínimo e o máximo aparece porque o servidor "
                "só inicia o próximo download quando o anterior termina. O primeiro cliente mede "
                "algo próximo do custo de uma transferência; o último soma a espera na fila.",
            )
        if thread["max_ms"] < serial["max_ms"] * 0.85:
            paragrafo(
                pdf,
                "A versão com uma thread por cliente reduziu o tempo de quem termina por último. "
                "As transferências ocorreram ao mesmo tempo e a fila do modo serial deixou de dominar o máximo.",
            )
        else:
            paragrafo(
                pdf,
                "Neste tamanho, criar uma thread por cliente não reduziu de forma clara o tempo máximo "
                "em relação ao modo serial. Na mesma máquina o limite costuma ser o disco e a CPU, "
                "compartilhados por todas as threads.",
            )
        if maior_n > dados["pool_n"] and pool["max_ms"] > thread["max_ms"] * 1.1:
            paragrafo(
                pdf,
                f"O pool, limitado a {dados['pool_n']} atendimentos simultâneos, ficou mais lento no máximo "
                "do que a versão sem limite. A partir do terceiro cliente surge espera, no meio do caminho "
                "entre o modo serial e o modo com uma thread por cliente.",
            )
        if p2p["max_ms"] < thread["max_ms"]:
            paragrafo(
                pdf,
                "O P2P concluiu a disseminação em menos tempo que o servidor com threads. "
                "Os pares que já tinham peças passaram a servi-las, e a origem deixou de concentrar todo o envio.",
            )
        else:
            paragrafo(
                pdf,
                "O P2P levou mais tempo que o servidor com threads. Cada peça abre trabalho de controle "
                "(pedido, anúncio e nova conexão) e, no loopback, não existe um enlace estreito no servidor "
                "no qual a republicação compensaria esse custo. O ensaio ainda mostra a disseminação correta: "
                "todos os pares receberam o arquivo íntegro, conferido pelo hash FNV-1a.",
            )
        paragrafo(pdf, f"Tempo máximo com {maior_n} clientes:", tamanho=11, estilo="B")
        barras(
            pdf,
            [
                ("CS serial", serial["max_ms"]),
                ("CS threads", thread["max_ms"]),
                (f"CS pool N={dados['pool_n']}", pool["max_ms"]),
                ("P2P", p2p["max_ms"]),
            ],
        )


def gerar_pdf(destino, dados):
    pdf = Relatorio(format="A4")
    pdf.add_font("DejaVu", "", FONTE)
    pdf.add_font("DejaVu", "B", FONTE_NEGRITO)
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.set_margins(15, 15, 15)
    pdf.add_page()

    paragrafo(pdf, "Universidade Federal de Sergipe", 12, "B")
    paragrafo(pdf, "Disciplina de Sistemas Distribuídos", 12)
    paragrafo(pdf, "Atividade 01 — Unidade 2", 12)
    pdf.ln(4)
    paragrafo(pdf, "Avaliação de desempenho na transferência de arquivos: cliente-servidor e P2P", 16, "B")
    paragrafo(pdf, f"Grupo: {dados['grupo']}")
    paragrafo(pdf, f"Execução: {dados['quando']}")
    paragrafo(
        pdf,
        f"Ambiente: {dados['ambiente']['sistema']}; {dados['ambiente']['cpus']} CPUs; Python {dados['ambiente']['python']}.",
    )

    titulo(pdf, "1. Objetivo")
    paragrafo(
        pdf,
        "O trabalho compara o tempo para concluir a transferência de um mesmo arquivo em quatro "
        "organizações: um servidor que atende um cliente por vez; um servidor que atende todos ao "
        "mesmo tempo, com uma thread por cliente; um servidor com pool que atende no máximo "
        f"{dados['pool_n']} clientes por vez; e uma disseminação P2P em que a máquina de origem e os "
        "pares que já receberam pedaços do arquivo servem uns aos outros. O arquivo recebido pelo "
        "cliente no modo cliente-servidor é descartado. No P2P o conteúdo fica disponível só enquanto "
        "o processo precisa republicá-lo e é removido ao encerrar.",
    )

    titulo(pdf, "2. Arquiteturas")
    paragrafo(
        pdf,
        "No cliente-servidor o cliente envia a linha GET e o servidor responde com o tamanho do arquivo, "
        "em 8 bytes big-endian, seguido dos bytes. O relógio do cliente começa antes do connect e para "
        "quando o último byte chega. O modo serial executa esse atendimento no laço principal. O modo "
        "com threads cria uma thread desanexada por conexão. O pool mantém um número fixo de "
        "trabalhadores e uma fila: no máximo N transferências ocorrem ao mesmo tempo; as demais "
        "esperam uma vaga.",
    )
    paragrafo(
        pdf,
        "No P2P há um tracker, um semeador e os pares. O arquivo é dividido em peças de "
        f"{dados['peca_bytes'] // 1024} KiB. O semeador registra todas as peças. Cada par anuncia as "
        "peças que já gravou e pede as que faltam, com até quatro conexões em paralelo e lotes de oito "
        "peças. O deslocamento inicial depende do identificador do par, para que não comecem todos "
        "pelo mesmo trecho. Enquanto um par ainda baixa, ele já serve o que possui. A inspiração é o "
        "BitTorrent (peças e republicação), com um escalonador mais simples: na hora de escolher de "
        "quem baixar, um par incompleto tem preferência sobre o semeador, porque já pode aliviar a origem.",
    )

    titulo(pdf, "3. Metodologia")
    paragrafo(
        pdf,
        "Os tamanhos pedidos são 5 MB, 50 MB e 500 MB, com MB = 1024 × 1024 bytes. "
        "A quantidade de clientes varia em 1, 2 e 4. Cada configuração é uma onda simultânea: "
        "todos os clientes daquela execução começam juntos. Mínimo, médio e máximo saem dos tempos "
        "de conclusão dessa onda, não de repetições separadas. Com um único cliente, os três valores coincidem.",
    )
    paragrafo(
        pdf,
        "Cada transferência é conferida com FNV-1a de 32 bits, calculado na origem e de novo em quem "
        "recebe. O experimento só entra na tabela se o tamanho e o hash baterem. Os programas estão em C "
        "(servidor, cliente e P2P). O roteiro que dispara os processos, calcula as estatísticas e gera este "
        "PDF está em Python. Tudo roda por Docker, para a compilação e a execução não dependerem do "
        "sistema do aluno.",
    )
    paragrafo(pdf, dados["observacao"])

    titulo(pdf, "4. Resultados")
    por_tamanho = defaultdict(list)
    for item in dados["experimentos"]:
        por_tamanho[item["tamanho_bytes"]].append(item)
    for tamanho in sorted(por_tamanho):
        itens = sorted(por_tamanho[tamanho], key=lambda item: (item["clientes"], item["arquitetura"]))
        mb = itens[0]["tamanho_mb"]
        paragrafo(pdf, f"Arquivo de {mb:.0f} MB ({tamanho} bytes)", 12, "B")
        tabela(pdf, itens)

    titulo(pdf, "5. Discussão")
    paragrafo(
        pdf,
        "O tempo mínimo aproxima o custo de uma transferência sem fila. O tempo máximo é o que importa "
        "para dizer quando o grupo todo terminou. O médio fica entre os dois e, no modo serial com vários "
        "clientes, acompanha a espera acumulada.",
    )
    discutir(pdf, dados)
    paragrafo(
        pdf,
        "Há um limite importante de interpretação. Todos os processos compartilham a mesma máquina e "
        "o loopback. Não há um enlace de rede saturado no servidor, que é justamente o cenário em que o "
        "P2P costuma ganhar de um cliente-servidor clássico: cada par novo traz capacidade de upload. "
        "Aqui o P2P mostra o mecanismo (peças, anúncio e republicação) e o custo do protocolo. Uma repetição "
        "em máquinas físicas distintas, com o semeador em um hospedeiro e os pares em outros, é o passo "
        "seguinte para observar esse ganho. Os binários já recebem host e porta justamente para isso.",
    )
    paragrafo(
        pdf,
        "Referências usadas como base conceitual: George Coulouris, Jean Dollimore, Tim Kindberg e "
        "Gordon Blair, Sistemas Distribuídos: Conceitos e Projeto; James Kurose e Keith Ross, "
        "Redes de Computadores e a Internet.",
    )

    titulo(pdf, "6. Conclusão")
    paragrafo(
        pdf,
        "O modo serial é previsível e limita a concorrência a um download. O modo com threads elimina "
        "essa fila e o pool devolve um teto configurável, útil quando atender todo mundo ao mesmo tempo "
        "compete por disco ou CPU. O P2P implementado distribui o arquivo da origem para os demais e, "
        "no caminho, os pares passam a servir peças. Na máquina única, o melhor tempo máximo depende "
        "do tamanho e da disputa local por recurso; a tabela desta execução é o registro desse comportamento, "
        "com integridade verificada em todas as transferências.",
    )

    titulo(pdf, "7. Como reproduzir")
    paragrafo(
        pdf,
        "Na pasta atv2-desempenho: docker compose up --build. O PDF, o JSON e o CSV aparecem em "
        "resultados/. Para uma matriz menor: docker compose run --rm experimento python3 "
        "scripts/experimento.py --tamanhos-mb 5 --clientes 1,2 --grupo \"Nomes\".",
    )

    destino = Path(destino)
    destino.parent.mkdir(parents=True, exist_ok=True)
    pdf.output(str(destino))
