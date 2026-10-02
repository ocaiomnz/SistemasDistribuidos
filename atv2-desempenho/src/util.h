#ifndef UTIL_H
#define UTIL_H

#define _POSIX_C_SOURCE 200809L

#include <stddef.h>
#include <stdint.h>

#define FNV_INIT 2166136261u

int escrever_tudo(int fd, const void *buf, size_t n);
int ler_tudo(int fd, void *buf, size_t n);
int ler_linha(int fd, char *buf, size_t cap);
uint64_t agora_ms(void);
void escrever_u64(uint8_t out[8], uint64_t valor);
uint64_t ler_u64(const uint8_t in[8]);
uint32_t fnv_atualizar(uint32_t hash, const uint8_t *dados, size_t n);
uint32_t fnv_arquivo(const char *caminho);
uint32_t fnv_fd(int fd, uint64_t tamanho);
int escutar_tcp(int porta);
int conectar_tcp(const char *host, int porta);
void aplicar_timeout(int fd, int segundos);
void ignorar_sigpipe(void);

#endif
