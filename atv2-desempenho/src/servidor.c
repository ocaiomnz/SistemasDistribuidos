#include "util.h"

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#define FILA_MAX 256

static char *caminho_arquivo = NULL;
static uint64_t tamanho_arquivo = 0;

static int fila[FILA_MAX];
static int fila_ini = 0;
static int fila_qtd = 0;
static pthread_mutex_t fila_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t fila_tem = PTHREAD_COND_INITIALIZER;
static pthread_cond_t fila_vaga = PTHREAD_COND_INITIALIZER;

static void atender_cliente(int fd) {
    char linha[32];
    if (ler_linha(fd, linha, sizeof linha) < 0) {
        return;
    }
    if (strcmp(linha, "GET") != 0) {
        return;
    }

    uint8_t cabecalho[8];
    escrever_u64(cabecalho, tamanho_arquivo);
    if (escrever_tudo(fd, cabecalho, sizeof cabecalho) < 0) {
        return;
    }

    int arquivo = open(caminho_arquivo, O_RDONLY);
    if (arquivo < 0) {
        return;
    }

    uint8_t buf[1 << 20];
    uint64_t falta = tamanho_arquivo;
    while (falta > 0) {
        size_t quer = sizeof buf;
        if ((uint64_t)quer > falta) {
            quer = (size_t)falta;
        }
        ssize_t lido = read(arquivo, buf, quer);
        if (lido <= 0) {
            break;
        }
        if (escrever_tudo(fd, buf, (size_t)lido) < 0) {
            break;
        }
        falta -= (uint64_t)lido;
    }
    close(arquivo);
}

static void *thread_atender(void *arg) {
    int fd = *(int *)arg;
    free(arg);
    atender_cliente(fd);
    close(fd);
    return NULL;
}

static void *trabalhador_pool(void *arg) {
    (void)arg;
    for (;;) {
        pthread_mutex_lock(&fila_mu);
        while (fila_qtd == 0) {
            pthread_cond_wait(&fila_tem, &fila_mu);
        }
        int fd = fila[fila_ini];
        fila_ini = (fila_ini + 1) % FILA_MAX;
        fila_qtd--;
        pthread_cond_signal(&fila_vaga);
        pthread_mutex_unlock(&fila_mu);
        atender_cliente(fd);
        close(fd);
    }
    return NULL;
}

static int iniciar_pool(int n) {
    for (int i = 0; i < n; i++) {
        pthread_t th;
        if (pthread_create(&th, NULL, trabalhador_pool, NULL) != 0) {
            return -1;
        }
        pthread_detach(th);
    }
    return 0;
}

static void enfileirar(int fd) {
    pthread_mutex_lock(&fila_mu);
    while (fila_qtd == FILA_MAX) {
        pthread_cond_wait(&fila_vaga, &fila_mu);
    }
    int pos = (fila_ini + fila_qtd) % FILA_MAX;
    fila[pos] = fd;
    fila_qtd++;
    pthread_cond_signal(&fila_tem);
    pthread_mutex_unlock(&fila_mu);
}

static void uso(void) {
    fprintf(stderr, "Uso: servidor <porta> <arquivo> <serial|thread|pool> [n]\n");
}

int main(int argc, char **argv) {
    ignorar_sigpipe();
    if (argc < 4) {
        uso();
        return 1;
    }

    int porta = atoi(argv[1]);
    caminho_arquivo = argv[2];
    const char *modo = argv[3];
    int pool_n = 2;
    if (argc >= 5) {
        pool_n = atoi(argv[4]);
    }
    if (porta <= 0 || porta > 65535) {
        fprintf(stderr, "Porta inválida\n");
        return 1;
    }

    int arquivo = open(caminho_arquivo, O_RDONLY);
    if (arquivo < 0) {
        perror("arquivo");
        return 1;
    }
    struct stat st;
    if (fstat(arquivo, &st) < 0) {
        perror("fstat");
        close(arquivo);
        return 1;
    }
    tamanho_arquivo = (uint64_t)st.st_size;
    close(arquivo);

    uint32_t hash = fnv_arquivo(caminho_arquivo);
    fprintf(stderr, "FNV %08x\n", hash);
    fprintf(stderr, "SERVIDOR %s porta %d bytes %llu\n", modo, porta, (unsigned long long)tamanho_arquivo);
    fflush(stderr);

    int ouvinte = escutar_tcp(porta);
    if (ouvinte < 0) {
        perror("escutar");
        return 1;
    }

    int eh_pool = strcmp(modo, "pool") == 0;
    int eh_thread = strcmp(modo, "thread") == 0;
    int eh_serial = strcmp(modo, "serial") == 0;
    if (!eh_pool && !eh_thread && !eh_serial) {
        uso();
        return 1;
    }
    if (eh_pool) {
        if (pool_n < 1 || pool_n > 64) {
            fprintf(stderr, "N do pool deve estar entre 1 e 64\n");
            return 1;
        }
        if (iniciar_pool(pool_n) < 0) {
            fprintf(stderr, "Falha ao criar o pool\n");
            return 1;
        }
    }

    for (;;) {
        int cliente = accept(ouvinte, NULL, NULL);
        if (cliente < 0) {
            if (errno == EINTR) {
                continue;
            }
            perror("accept");
            return 1;
        }
        aplicar_timeout(cliente, 300);
        if (eh_serial) {
            atender_cliente(cliente);
            close(cliente);
        } else if (eh_thread) {
            int *fd = malloc(sizeof(int));
            if (!fd) {
                close(cliente);
                continue;
            }
            *fd = cliente;
            pthread_t th;
            if (pthread_create(&th, NULL, thread_atender, fd) != 0) {
                free(fd);
                close(cliente);
                continue;
            }
            pthread_detach(th);
        } else {
            enfileirar(cliente);
        }
    }
}
