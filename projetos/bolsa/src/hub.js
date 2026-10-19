const clientes = new Set();

export function adicionarCliente(usuarioId, resposta) {
  const cliente = { usuarioId, resposta };
  clientes.add(cliente);
  return cliente;
}

export function removerCliente(cliente) {
  clientes.delete(cliente);
}

export function quantidadeConectada() {
  return clientes.size;
}

export function publicar(evento) {
  const pacote = `data: ${JSON.stringify(evento)}\n\n`;
  for (const cliente of clientes) {
    try {
      cliente.resposta.write(pacote);
    } catch {
      clientes.delete(cliente);
    }
  }
}
