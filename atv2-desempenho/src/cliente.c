#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void uso(void) {
    fprintf(stderr, "Uso: cliente <host> <porta>\n");
}

int main(int argc, char **argv) {
    ignorar_sigpipe();
    if (argc != 3) {
        uso();
        return 1;
    }
    const char *host = argv[1];
    int porta = atoi(argv[2]);
    if (porta <= 0 || porta > 65535) {
        fprintf(stderr, "Porta inválida\n");
        return 1;
    }

    uint64_t inicio = agora_ms();
    int fd = conectar_tcp(host, porta);
    if (fd < 0) {
        perror("connect");
        return 1;
    }
    aplicar_timeout(fd, 300);

    if (escrever_tudo(fd, "GET\n", 4) < 0) {
        fprintf(stderr, "Falha ao pedir o arquivo\n");
        return 1;
    }

    uint8_t cabecalho[8];
    if (ler_tudo(fd, cabecalho, sizeof cabecalho) < 0) {
        fprintf(stderr, "Falha ao ler o tamanho\n");
        return 1;
    }
    uint64_t tamanho = ler_u64(cabecalho);
    uint32_t hash = FNV_INIT;
    uint8_t buf[1 << 20];
    uint64_t falta = tamanho;
    while (falta > 0) {
        size_t quer = sizeof buf;
        if ((uint64_t)quer > falta) {
            quer = (size_t)falta;
        }
        if (ler_tudo(fd, buf, quer) < 0) {
            fprintf(stderr, "Transferência incompleta\n");
            return 1;
        }
        hash = fnv_atualizar(hash, buf, quer);
        falta -= (uint64_t)quer;
    }

    uint64_t fim = agora_ms();
    printf("TEMPO_MS %llu BYTES %llu FNV %08x\n",
           (unsigned long long)(fim - inicio),
           (unsigned long long)tamanho,
           hash);
    fflush(stdout);
    return 0;
}
