#include "util.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

int escrever_tudo(int fd, const void *buf, size_t n) {
    const uint8_t *p = buf;
    size_t falta = n;
    while (falta > 0) {
        ssize_t escrito = write(fd, p, falta);
        if (escrito < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        if (escrito == 0) {
            return -1;
        }
        p += escrito;
        falta -= (size_t)escrito;
    }
    return 0;
}

int ler_tudo(int fd, void *buf, size_t n) {
    uint8_t *p = buf;
    size_t falta = n;
    while (falta > 0) {
        ssize_t lido = read(fd, p, falta);
        if (lido < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        if (lido == 0) {
            return -1;
        }
        p += lido;
        falta -= (size_t)lido;
    }
    return 0;
}

int ler_linha(int fd, char *buf, size_t cap) {
    size_t i = 0;
    if (cap == 0) {
        return -1;
    }
    while (i + 1 < cap) {
        char c;
        ssize_t n = read(fd, &c, 1);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        if (n == 0) {
            if (i == 0) {
                return -1;
            }
            break;
        }
        if (c == '\n') {
            break;
        }
        if (c != '\r') {
            buf[i++] = c;
        }
    }
    buf[i] = '\0';
    return (int)i;
}

uint64_t agora_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000ull + (uint64_t)ts.tv_nsec / 1000000ull;
}

void escrever_u64(uint8_t out[8], uint64_t valor) {
    for (int i = 7; i >= 0; i--) {
        out[i] = (uint8_t)(valor & 0xffu);
        valor >>= 8;
    }
}

uint64_t ler_u64(const uint8_t in[8]) {
    uint64_t valor = 0;
    for (int i = 0; i < 8; i++) {
        valor = (valor << 8) | in[i];
    }
    return valor;
}

uint32_t fnv_atualizar(uint32_t hash, const uint8_t *dados, size_t n) {
    for (size_t i = 0; i < n; i++) {
        hash ^= dados[i];
        hash *= 16777619u;
    }
    return hash;
}

static uint32_t fnv_ler(int fd, uint64_t tamanho) {
    uint32_t hash = FNV_INIT;
    uint8_t buf[1 << 20];
    uint64_t off = 0;
    while (off < tamanho) {
        size_t quer = sizeof buf;
        if ((uint64_t)quer > tamanho - off) {
            quer = (size_t)(tamanho - off);
        }
        ssize_t n = pread(fd, buf, quer, (off_t)off);
        if (n <= 0) {
            break;
        }
        hash = fnv_atualizar(hash, buf, (size_t)n);
        off += (uint64_t)n;
    }
    return hash;
}

uint32_t fnv_arquivo(const char *caminho) {
    int fd = open(caminho, O_RDONLY);
    if (fd < 0) {
        return 0;
    }
    struct stat st;
    if (fstat(fd, &st) < 0) {
        close(fd);
        return 0;
    }
    uint32_t hash = fnv_ler(fd, (uint64_t)st.st_size);
    close(fd);
    return hash;
}

uint32_t fnv_fd(int fd, uint64_t tamanho) {
    return fnv_ler(fd, tamanho);
}

int escutar_tcp(int porta) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return -1;
    }
    int ligado = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &ligado, sizeof ligado);
    struct sockaddr_in endereco;
    memset(&endereco, 0, sizeof endereco);
    endereco.sin_family = AF_INET;
    endereco.sin_addr.s_addr = htonl(INADDR_ANY);
    endereco.sin_port = htons((uint16_t)porta);
    if (bind(fd, (struct sockaddr *)&endereco, sizeof endereco) < 0) {
        close(fd);
        return -1;
    }
    if (listen(fd, 128) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

int conectar_tcp(const char *host, int porta) {
    char porta_txt[16];
    snprintf(porta_txt, sizeof porta_txt, "%d", porta);
    struct addrinfo dicas;
    memset(&dicas, 0, sizeof dicas);
    dicas.ai_family = AF_INET;
    dicas.ai_socktype = SOCK_STREAM;
    struct addrinfo *res = NULL;
    if (getaddrinfo(host, porta_txt, &dicas, &res) != 0) {
        return -1;
    }
    int fd = -1;
    for (struct addrinfo *p = res; p != NULL; p = p->ai_next) {
        fd = socket(p->ai_family, p->ai_socktype, p->ai_protocol);
        if (fd < 0) {
            continue;
        }
        if (connect(fd, p->ai_addr, p->ai_addrlen) == 0) {
            break;
        }
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    return fd;
}

void aplicar_timeout(int fd, int segundos) {
    struct timeval tv;
    tv.tv_sec = segundos;
    tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    int ligado = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &ligado, sizeof ligado);
}

void ignorar_sigpipe(void) {
    signal(SIGPIPE, SIG_IGN);
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
}
