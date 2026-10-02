#include "util.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define TAMANHO_PECA (256 * 1024)
#define MAX_PECAS 20000
#define MAX_PARES 32
#define MAX_ID 32
#define PARALELO 4
#define LOTE 8
#define HEX_MAX 8192

typedef struct {
    int ativo;
    char id[MAX_ID];
    char ip[INET_ADDRSTRLEN];
    int porta;
    uint8_t bitfield[(MAX_PECAS + 7) / 8];
} ParInfo;

static ParInfo pares[MAX_PARES];
static int num_pecas = 0;
static uint64_t tam_arquivo = 0;
static int tam_peca = TAMANHO_PECA;
static int meta_pronta = 0;
static pthread_mutex_t pares_mu = PTHREAD_MUTEX_INITIALIZER;

static int g_fd = -1;
static uint8_t *g_bits = NULL;
static int g_tenho = 0;
static pthread_mutex_t bits_mu = PTHREAD_MUTEX_INITIALIZER;
static char g_id[MAX_ID];
static char g_tracker_host[128];
static int g_tracker_porta = 0;
static int g_sou_semeador = 0;

static int bytes_bitfield(void) {
    return (num_pecas + 7) / 8;
}

static int tem_peca(const uint8_t *bits, int indice) {
    return (bits[indice / 8] >> (indice % 8)) & 1;
}

static void marca_peca(uint8_t *bits, int indice) {
    bits[indice / 8] |= (uint8_t)(1u << (indice % 8));
}

static void para_hex(const uint8_t *bits, int nbytes, char *saida) {
    static const char *digitos = "0123456789abcdef";
    for (int i = 0; i < nbytes; i++) {
        saida[i * 2] = digitos[bits[i] >> 4];
        saida[i * 2 + 1] = digitos[bits[i] & 0x0f];
    }
    saida[nbytes * 2] = '\0';
}

static int de_hex(const char *hex, uint8_t *bits, int nbytes) {
    if ((int)strlen(hex) != nbytes * 2) {
        return -1;
    }
    for (int i = 0; i < nbytes; i++) {
        char par[3] = {hex[i * 2], hex[i * 2 + 1], '\0'};
        if (!isxdigit((unsigned char)par[0]) || !isxdigit((unsigned char)par[1])) {
            return -1;
        }
        bits[i] = (uint8_t)strtol(par, NULL, 16);
    }
    return 0;
}

static size_t tamanho_da_peca(int indice) {
    uint64_t off = (uint64_t)indice * (uint64_t)tam_peca;
    uint64_t resto = tam_arquivo - off;
    if (resto > (uint64_t)tam_peca) {
        return (size_t)tam_peca;
    }
    return (size_t)resto;
}

static int responder(int fd, const char *texto) {
    return escrever_tudo(fd, texto, strlen(texto));
}

static ParInfo *buscar_par(const char *id) {
    for (int i = 0; i < MAX_PARES; i++) {
        if (pares[i].ativo && strcmp(pares[i].id, id) == 0) {
            return &pares[i];
        }
    }
    return NULL;
}

static ParInfo *vaga_par(void) {
    for (int i = 0; i < MAX_PARES; i++) {
        if (!pares[i].ativo) {
            return &pares[i];
        }
    }
    return NULL;
}

static void preencher_tudo(uint8_t *bits) {
    memset(bits, 0, sizeof pares[0].bitfield);
    for (int i = 0; i < num_pecas; i++) {
        marca_peca(bits, i);
    }
}

static int comando_tracker(int fd, const char *linha, const char *ip) {
    if (strncmp(linha, "SEED ", 5) == 0) {
        char id[MAX_ID];
        int porta = 0;
        int peca = 0;
        unsigned long long tamanho = 0;
        if (sscanf(linha, "SEED %31s %d %llu %d", id, &porta, &tamanho, &peca) != 4) {
            return responder(fd, "ERR\n");
        }
        if (porta <= 0 || porta > 65535 || peca <= 0 || tamanho == 0) {
            return responder(fd, "ERR\n");
        }
        int pecas = (int)((tamanho + (unsigned long long)peca - 1ull) / (unsigned long long)peca);
        if (pecas <= 0 || pecas > MAX_PECAS) {
            return responder(fd, "ERR\n");
        }
        pthread_mutex_lock(&pares_mu);
        tam_arquivo = tamanho;
        tam_peca = peca;
        num_pecas = pecas;
        meta_pronta = 1;
        ParInfo *par = buscar_par(id);
        if (!par) {
            par = vaga_par();
        }
        if (!par) {
            pthread_mutex_unlock(&pares_mu);
            return responder(fd, "ERR\n");
        }
        memset(par, 0, sizeof *par);
        par->ativo = 1;
        snprintf(par->id, sizeof par->id, "%s", id);
        snprintf(par->ip, sizeof par->ip, "%s", ip);
        par->porta = porta;
        preencher_tudo(par->bitfield);
        pthread_mutex_unlock(&pares_mu);
        fprintf(stderr, "[tracker] semeador %s %s:%d pecas %d\n", id, ip, porta, pecas);
        return responder(fd, "OK\n");
    }

    if (strncmp(linha, "JOIN ", 5) == 0) {
        char id[MAX_ID];
        int porta = 0;
        if (sscanf(linha, "JOIN %31s %d", id, &porta) != 2 || porta <= 0 || porta > 65535) {
            return responder(fd, "ERR\n");
        }
        pthread_mutex_lock(&pares_mu);
        if (!meta_pronta) {
            pthread_mutex_unlock(&pares_mu);
            return responder(fd, "RETRY\n");
        }
        ParInfo *par = buscar_par(id);
        if (!par) {
            par = vaga_par();
            if (!par) {
                pthread_mutex_unlock(&pares_mu);
                return responder(fd, "ERR\n");
            }
            memset(par, 0, sizeof *par);
            par->ativo = 1;
            snprintf(par->id, sizeof par->id, "%s", id);
        }
        snprintf(par->ip, sizeof par->ip, "%s", ip);
        par->porta = porta;
        int pecas = num_pecas;
        unsigned long long tamanho = tam_arquivo;
        int peca = tam_peca;
        pthread_mutex_unlock(&pares_mu);
        char resposta[128];
        snprintf(resposta, sizeof resposta, "META %llu %d %d\n", tamanho, peca, pecas);
        fprintf(stderr, "[tracker] par %s %s:%d\n", id, ip, porta);
        return responder(fd, resposta);
    }

    if (strcmp(linha, "PEERS") == 0) {
        pthread_mutex_lock(&pares_mu);
        int n = 0;
        for (int i = 0; i < MAX_PARES; i++) {
            if (pares[i].ativo) {
                n++;
            }
        }
        int nbytes = num_pecas > 0 ? bytes_bitfield() : 0;
        size_t cap = 64 + (size_t)n * (160 + (size_t)nbytes * 2);
        char *buf = malloc(cap);
        if (!buf) {
            pthread_mutex_unlock(&pares_mu);
            return -1;
        }
        size_t usado = (size_t)snprintf(buf, cap, "N %d\n", n);
        for (int i = 0; i < MAX_PARES; i++) {
            if (!pares[i].ativo) {
                continue;
            }
            char hex[HEX_MAX];
            if (nbytes * 2 + 1 > HEX_MAX) {
                free(buf);
                pthread_mutex_unlock(&pares_mu);
                return responder(fd, "ERR\n");
            }
            para_hex(pares[i].bitfield, nbytes, hex);
            int escrito = snprintf(buf + usado, cap - usado, "%s %s %d %s\n", pares[i].id, pares[i].ip, pares[i].porta, hex);
            if (escrito < 0 || (size_t)escrito >= cap - usado) {
                free(buf);
                pthread_mutex_unlock(&pares_mu);
                return responder(fd, "ERR\n");
            }
            usado += (size_t)escrito;
        }
        pthread_mutex_unlock(&pares_mu);
        int rc = escrever_tudo(fd, buf, usado);
        free(buf);
        return rc;
    }

    if (strncmp(linha, "HAVE ", 5) == 0) {
        char id[MAX_ID];
        int indice = -1;
        if (sscanf(linha, "HAVE %31s %d", id, &indice) != 2) {
            return responder(fd, "ERR\n");
        }
        pthread_mutex_lock(&pares_mu);
        ParInfo *par = buscar_par(id);
        if (!par || indice < 0 || indice >= num_pecas) {
            pthread_mutex_unlock(&pares_mu);
            return responder(fd, "ERR\n");
        }
        marca_peca(par->bitfield, indice);
        pthread_mutex_unlock(&pares_mu);
        return responder(fd, "OK\n");
    }

    if (strcmp(linha, "QUIT") == 0) {
        return 1;
    }
    return responder(fd, "ERR\n");
}

static int run_tracker(int porta) {
    int ouvinte = escutar_tcp(porta);
    if (ouvinte < 0) {
        perror("tracker");
        return 1;
    }
    fprintf(stderr, "[tracker] porta %d\n", porta);
    fflush(stderr);
    for (;;) {
        struct sockaddr_in cli;
        socklen_t sl = sizeof cli;
        int c = accept(ouvinte, (struct sockaddr *)&cli, &sl);
        if (c < 0) {
            if (errno == EINTR) {
                continue;
            }
            perror("accept");
            return 1;
        }
        aplicar_timeout(c, 30);
        char ip[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &cli.sin_addr, ip, sizeof ip);
        char linha[HEX_MAX];
        while (ler_linha(c, linha, sizeof linha) >= 0) {
            int rc = comando_tracker(c, linha, ip);
            if (rc != 0) {
                break;
            }
        }
        close(c);
    }
}

static int sessao_tracker(char *linha, size_t cap, const char *envio) {
    int fd = conectar_tcp(g_tracker_host, g_tracker_porta);
    if (fd < 0) {
        return -1;
    }
    aplicar_timeout(fd, 30);
    int rc = -1;
    if (escrever_tudo(fd, envio, strlen(envio)) == 0 && ler_linha(fd, linha, cap) >= 0) {
        rc = 0;
    }
    close(fd);
    return rc;
}

static void anunciar_pecas(const int *indices, int n) {
    if (n <= 0) {
        return;
    }
    int fd = conectar_tcp(g_tracker_host, g_tracker_porta);
    if (fd < 0) {
        return;
    }
    aplicar_timeout(fd, 30);
    for (int i = 0; i < n; i++) {
        char cmd[96];
        char resp[32];
        snprintf(cmd, sizeof cmd, "HAVE %s %d\n", g_id, indices[i]);
        if (escrever_tudo(fd, cmd, strlen(cmd)) < 0 || ler_linha(fd, resp, sizeof resp) < 0) {
            break;
        }
    }
    escrever_tudo(fd, "QUIT\n", 5);
    close(fd);
}

typedef struct {
    char ip[INET_ADDRSTRLEN];
    int porta;
    uint8_t *bits;
    int indices[LOTE];
    int quantidade;
    int ok[LOTE];
} Lote;

static void *baixar_lote(void *arg) {
    Lote *lote = arg;
    int fd = conectar_tcp(lote->ip, lote->porta);
    if (fd < 0) {
        return NULL;
    }
    aplicar_timeout(fd, 60);
    uint8_t *buf = malloc((size_t)tam_peca);
    if (!buf) {
        close(fd);
        return NULL;
    }
    for (int i = 0; i < lote->quantidade; i++) {
        char cmd[64];
        char linha[128];
        int indice = lote->indices[i];
        snprintf(cmd, sizeof cmd, "GET %d\n", indice);
        if (escrever_tudo(fd, cmd, strlen(cmd)) < 0 || ler_linha(fd, linha, sizeof linha) < 0) {
            break;
        }
        int recebido = -1;
        int len = -1;
        if (sscanf(linha, "PIECE %d %d", &recebido, &len) != 2 || recebido != indice || len <= 0) {
            break;
        }
        if (ler_tudo(fd, buf, (size_t)len) < 0) {
            break;
        }
        off_t off = (off_t)indice * tam_peca;
        if (pwrite(g_fd, buf, (size_t)len, off) != (ssize_t)len) {
            break;
        }
        lote->ok[i] = 1;
    }
    escrever_tudo(fd, "QUIT\n", 5);
    free(buf);
    close(fd);
    return NULL;
}

static int ja_usado(const int *usados, int n, int indice) {
    for (int i = 0; i < n; i++) {
        if (usados[i] == indice) {
            return 1;
        }
    }
    return 0;
}

static void dormir_us(unsigned micros) {
    struct timespec ts;
    ts.tv_sec = micros / 1000000u;
    ts.tv_nsec = (long)(micros % 1000000u) * 1000L;
    nanosleep(&ts, NULL);
}

static int baixar_tudo(void) {
    int deslocamento = 0;
    unsigned hash = FNV_INIT;
    for (const char *p = g_id; *p; p++) {
        hash ^= (unsigned char)*p;
        hash *= 16777619u;
    }
    if (num_pecas > 0) {
        deslocamento = (int)(hash % (unsigned)num_pecas);
    }

    while (g_tenho < num_pecas) {
        char primeira[32];
        if (sessao_tracker(primeira, sizeof primeira, "PEERS\n") < 0) {
            dormir_us(50000);
            continue;
        }
        if (strncmp(primeira, "N ", 2) != 0) {
            dormir_us(50000);
            continue;
        }
        int n = atoi(primeira + 2);
        if (n < 0 || n > MAX_PARES) {
            dormir_us(50000);
            continue;
        }

        typedef struct {
            char id[MAX_ID];
            char ip[INET_ADDRSTRLEN];
            int porta;
            uint8_t bits[(MAX_PECAS + 7) / 8];
            int util;
        } Visao;
        Visao *visoes = calloc((size_t)MAX_PARES, sizeof(Visao));
        if (!visoes) {
            return -1;
        }
        int fd = conectar_tcp(g_tracker_host, g_tracker_porta);
        int lidas = 0;
        if (fd >= 0) {
            aplicar_timeout(fd, 30);
            if (escrever_tudo(fd, "PEERS\n", 6) == 0) {
                char cab[32];
                if (ler_linha(fd, cab, sizeof cab) >= 0) {
                    int total = atoi(cab + 2);
                    int nbytes = bytes_bitfield();
                    for (int i = 0; i < total && i < MAX_PARES; i++) {
                        char linha[HEX_MAX];
                        if (ler_linha(fd, linha, sizeof linha) < 0) {
                            break;
                        }
                        char hex[HEX_MAX];
                        if (sscanf(linha, "%31s %15s %d %8191s", visoes[lidas].id, visoes[lidas].ip, &visoes[lidas].porta, hex) != 4) {
                            continue;
                        }
                        if (strcmp(visoes[lidas].id, g_id) == 0) {
                            continue;
                        }
                        if (de_hex(hex, visoes[lidas].bits, nbytes) < 0) {
                            continue;
                        }
                        visoes[lidas].util = 1;
                        lidas++;
                    }
                }
            }
            escrever_tudo(fd, "QUIT\n", 5);
            close(fd);
        }
        (void)n;

        int usados[PARALELO * LOTE];
        int n_usados = 0;
        Lote lotes[PARALELO];
        memset(lotes, 0, sizeof lotes);
        int n_lotes = 0;
        int penalidade[MAX_PARES];
        memset(penalidade, 0, sizeof penalidade);
        while (n_lotes < PARALELO) {
            int escolhido = -1;
            int melhor = 0;
            for (int k = 0; k < lidas; k++) {
                int disponiveis = 0;
                int tem_todas = 1;
                for (int passo = 0; passo < num_pecas; passo++) {
                    int indice = (deslocamento + passo) % num_pecas;
                    if (!tem_peca(visoes[k].bits, indice)) {
                        tem_todas = 0;
                    }
                    if (tem_peca(g_bits, indice) || ja_usado(usados, n_usados, indice)) {
                        continue;
                    }
                    if (tem_peca(visoes[k].bits, indice)) {
                        disponiveis++;
                    }
                }
                if (disponiveis == 0) {
                    continue;
                }
                int nota = disponiveis - penalidade[k] * LOTE;
                if (!tem_todas) {
                    nota += num_pecas;
                }
                if (escolhido < 0 || nota > melhor) {
                    melhor = nota;
                    escolhido = k;
                }
            }
            if (escolhido < 0) {
                break;
            }
            Lote *lote = &lotes[n_lotes];
            snprintf(lote->ip, sizeof lote->ip, "%s", visoes[escolhido].ip);
            lote->porta = visoes[escolhido].porta;
            for (int passo = 0; passo < num_pecas && lote->quantidade < LOTE; passo++) {
                int indice = (deslocamento + passo) % num_pecas;
                if (tem_peca(g_bits, indice) || ja_usado(usados, n_usados, indice)) {
                    continue;
                }
                if (!tem_peca(visoes[escolhido].bits, indice)) {
                    continue;
                }
                lote->indices[lote->quantidade++] = indice;
                usados[n_usados++] = indice;
            }
            if (lote->quantidade == 0) {
                break;
            }
            penalidade[escolhido]++;
            n_lotes++;
        }
        free(visoes);

        if (n_lotes == 0) {
            dormir_us(30000);
            continue;
        }

        pthread_t ths[PARALELO];
        for (int i = 0; i < n_lotes; i++) {
            if (pthread_create(&ths[i], NULL, baixar_lote, &lotes[i]) != 0) {
                lotes[i].quantidade = 0;
            }
        }
        for (int i = 0; i < n_lotes; i++) {
            if (lotes[i].quantidade > 0) {
                pthread_join(ths[i], NULL);
            }
        }

        int novos[PARALELO * LOTE];
        int n_novos = 0;
        pthread_mutex_lock(&bits_mu);
        for (int i = 0; i < n_lotes; i++) {
            for (int j = 0; j < lotes[i].quantidade; j++) {
                if (!lotes[i].ok[j]) {
                    continue;
                }
                int indice = lotes[i].indices[j];
                if (!tem_peca(g_bits, indice)) {
                    marca_peca(g_bits, indice);
                    g_tenho++;
                    novos[n_novos++] = indice;
                }
            }
        }
        int tenho = g_tenho;
        pthread_mutex_unlock(&bits_mu);
        anunciar_pecas(novos, n_novos);
        fprintf(stderr, "[%s] pecas %d/%d\n", g_id, tenho, num_pecas);
    }
    return 0;
}

static void *atender_par(void *arg) {
    int fd = *(int *)arg;
    free(arg);
    aplicar_timeout(fd, 60);
    char linha[128];
    while (ler_linha(fd, linha, sizeof linha) >= 0) {
        if (strcmp(linha, "QUIT") == 0) {
            break;
        }
        int indice = -1;
        if (sscanf(linha, "GET %d", &indice) != 1 || indice < 0 || indice >= num_pecas) {
            responder(fd, "ERR\n");
            break;
        }
        pthread_mutex_lock(&bits_mu);
        int possui = g_sou_semeador || (g_bits && tem_peca(g_bits, indice));
        pthread_mutex_unlock(&bits_mu);
        if (!possui) {
            responder(fd, "ERR\n");
            break;
        }
        size_t len = tamanho_da_peca(indice);
        uint8_t *buf = malloc(len);
        if (!buf) {
            responder(fd, "ERR\n");
            break;
        }
        ssize_t lido = pread(g_fd, buf, len, (off_t)indice * tam_peca);
        if (lido != (ssize_t)len) {
            free(buf);
            responder(fd, "ERR\n");
            break;
        }
        char cab[64];
        snprintf(cab, sizeof cab, "PIECE %d %zu\n", indice, len);
        int rc = escrever_tudo(fd, cab, strlen(cab));
        if (rc == 0) {
            rc = escrever_tudo(fd, buf, len);
        }
        free(buf);
        if (rc < 0) {
            break;
        }
    }
    close(fd);
    return NULL;
}

static void *loop_aceitar(void *arg) {
    int ouvinte = (int)(intptr_t)arg;
    for (;;) {
        int c = accept(ouvinte, NULL, NULL);
        if (c < 0) {
            if (errno == EINTR) {
                continue;
            }
            continue;
        }
        int *fd = malloc(sizeof(int));
        if (!fd) {
            close(c);
            continue;
        }
        *fd = c;
        pthread_t th;
        if (pthread_create(&th, NULL, atender_par, fd) != 0) {
            free(fd);
            close(c);
            continue;
        }
        pthread_detach(th);
    }
    return NULL;
}

static int registrar_semeador(int porta) {
    char cmd[160];
    char resp[32];
    snprintf(cmd, sizeof cmd, "SEED %s %d %llu %d\n", g_id, porta, (unsigned long long)tam_arquivo, tam_peca);
    if (sessao_tracker(resp, sizeof resp, cmd) < 0 || strcmp(resp, "OK") != 0) {
        fprintf(stderr, "[semeador] falha no registro: %s\n", resp);
        return -1;
    }
    return 0;
}

static int registrar_par(int porta) {
    char cmd[96];
    snprintf(cmd, sizeof cmd, "JOIN %s %d\n", g_id, porta);
    for (int i = 0; i < 50; i++) {
        char resp[128];
        if (sessao_tracker(resp, sizeof resp, cmd) == 0) {
            unsigned long long tamanho = 0;
            int peca = 0;
            int pecas = 0;
            if (sscanf(resp, "META %llu %d %d", &tamanho, &peca, &pecas) == 3 && pecas > 0 && pecas <= MAX_PECAS) {
                tam_arquivo = tamanho;
                tam_peca = peca;
                num_pecas = pecas;
                return 0;
            }
        }
        dormir_us(100000);
    }
    fprintf(stderr, "[%s] sem metadados do tracker\n", g_id);
    return -1;
}

static int preparar_arquivo_par(void) {
    char modelo[] = "/tmp/p2p-XXXXXX";
    g_fd = mkstemp(modelo);
    if (g_fd < 0) {
        perror("mkstemp");
        return -1;
    }
    unlink(modelo);
    if (ftruncate(g_fd, (off_t)tam_arquivo) < 0) {
        perror("ftruncate");
        return -1;
    }
    g_bits = calloc((size_t)bytes_bitfield(), 1);
    if (!g_bits) {
        return -1;
    }
    return 0;
}

static int run_no(int semeador, const char *host, int porta_tracker, int porta, const char *id, const char *arquivo) {
    snprintf(g_id, sizeof g_id, "%s", id);
    snprintf(g_tracker_host, sizeof g_tracker_host, "%s", host);
    g_tracker_porta = porta_tracker;
    g_sou_semeador = semeador;

    if (semeador) {
        g_fd = open(arquivo, O_RDONLY);
        if (g_fd < 0) {
            perror(arquivo);
            return 1;
        }
        struct stat st;
        if (fstat(g_fd, &st) < 0 || st.st_size <= 0) {
            fprintf(stderr, "Arquivo inválido\n");
            return 1;
        }
        tam_arquivo = (uint64_t)st.st_size;
        tam_peca = TAMANHO_PECA;
        num_pecas = (int)((tam_arquivo + (uint64_t)tam_peca - 1ull) / (uint64_t)tam_peca);
        if (num_pecas > MAX_PECAS) {
            fprintf(stderr, "Arquivo grande demais para o tamanho de peça\n");
            return 1;
        }
        uint32_t hash = fnv_fd(g_fd, tam_arquivo);
        fprintf(stderr, "FNV %08x\n", hash);
        fflush(stderr);
        if (registrar_semeador(porta) < 0) {
            return 1;
        }
    } else if (registrar_par(porta) < 0 || preparar_arquivo_par() < 0) {
        return 1;
    }

    int ouvinte = escutar_tcp(porta);
    if (ouvinte < 0) {
        perror("escuta do par");
        return 1;
    }
    pthread_t th;
    if (pthread_create(&th, NULL, loop_aceitar, (void *)(intptr_t)ouvinte) != 0) {
        return 1;
    }

    if (!semeador) {
        uint64_t inicio = agora_ms();
        if (baixar_tudo() < 0) {
            return 1;
        }
        uint64_t fim = agora_ms();
        uint32_t hash = fnv_fd(g_fd, tam_arquivo);
        printf("TEMPO_MS %llu BYTES %llu FNV %08x\n",
               (unsigned long long)(fim - inicio),
               (unsigned long long)tam_arquivo,
               hash);
        fflush(stdout);
    } else {
        fprintf(stderr, "[semeador] servindo %d pecas\n", num_pecas);
        fflush(stderr);
    }

    for (;;) {
        pause();
    }
}

static void uso(void) {
    fprintf(stderr,
            "Uso:\n"
            "  p2p tracker <porta>\n"
            "  p2p seeder <host> <porta_tracker> <porta> <id> <arquivo>\n"
            "  p2p peer <host> <porta_tracker> <porta> <id>\n");
}

int main(int argc, char **argv) {
    ignorar_sigpipe();
    if (argc < 3) {
        uso();
        return 1;
    }
    if (strcmp(argv[1], "tracker") == 0) {
        return run_tracker(atoi(argv[2]));
    }
    if (strcmp(argv[1], "seeder") == 0) {
        if (argc != 7) {
            uso();
            return 1;
        }
        return run_no(1, argv[2], atoi(argv[3]), atoi(argv[4]), argv[5], argv[6]);
    }
    if (strcmp(argv[1], "peer") == 0) {
        if (argc != 6) {
            uso();
            return 1;
        }
        return run_no(0, argv[2], atoi(argv[3]), atoi(argv[4]), argv[5], NULL);
    }
    uso();
    return 1;
}
