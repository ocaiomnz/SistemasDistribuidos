export class ErroNegocio extends Error {
  constructor(mensagem, tipo = "regra") {
    super(mensagem);
    this.status = 400;
    this.tipo = tipo;
  }
}

export class ErroAcesso extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.status = 403;
  }
}

export class ErroServico extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.status = 503;
  }
}

export function ehFalhaDeInfra(erro) {
  return !(erro instanceof ErroNegocio || erro instanceof ErroAcesso || erro instanceof ErroServico);
}
