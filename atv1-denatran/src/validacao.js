export function texto(valor, campo) {
  if (valor === undefined || valor === null) {
    throw new Error(`Campo obrigatório: ${campo}`);
  }
  const textoLimpo = String(valor).trim();
  if (!textoLimpo) {
    throw new Error(`Campo obrigatório: ${campo}`);
  }
  return textoLimpo;
}

export function cpf(valor) {
  const digitos = texto(valor, "cpf").replace(/\D/g, "");
  if (digitos.length !== 11) {
    throw new Error("CPF deve ter 11 dígitos");
  }
  return digitos;
}

export function placa(valor) {
  const normalizada = texto(valor, "placa").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalizada.length !== 7) {
    throw new Error("Placa deve ter 7 caracteres");
  }
  return normalizada;
}

export function inteiro(valor, campo) {
  if (typeof valor === "string" && valor.trim() === "") {
    throw new Error(`Campo obrigatório: ${campo}`);
  }
  const numero = Number(valor);
  if (!Number.isInteger(numero)) {
    throw new Error(`${campo} deve ser um número inteiro`);
  }
  return numero;
}

export function ano(valor, campo = "ano") {
  const numero = inteiro(valor, campo);
  if (numero < 1980 || numero > 2100) {
    throw new Error(`${campo} inválido`);
  }
  return numero;
}

export function valorVeiculo(valor) {
  if (typeof valor === "string" && valor.trim() === "") {
    throw new Error("Campo obrigatório: valor");
  }
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) {
    throw new Error("Valor do veículo deve ser positivo");
  }
  return numero;
}

export function arredondar(numero) {
  return Math.round((numero + Number.EPSILON) * 100) / 100;
}
