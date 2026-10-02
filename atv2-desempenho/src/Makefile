CC=gcc
CFLAGS=-O2 -Wall -Wextra -pthread -std=c11
LDFLAGS=-pthread
BIN=../bin

.PHONY: all clean

all: $(BIN)/servidor $(BIN)/cliente $(BIN)/p2p

$(BIN):
	mkdir -p $(BIN)

$(BIN)/servidor: servidor.c util.c util.h | $(BIN)
	$(CC) $(CFLAGS) -o $@ servidor.c util.c $(LDFLAGS)

$(BIN)/cliente: cliente.c util.c util.h | $(BIN)
	$(CC) $(CFLAGS) -o $@ cliente.c util.c $(LDFLAGS)

$(BIN)/p2p: p2p.c util.c util.h | $(BIN)
	$(CC) $(CFLAGS) -o $@ p2p.c util.c $(LDFLAGS)

clean:
	rm -rf $(BIN)
