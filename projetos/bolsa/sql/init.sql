SET NAMES utf8mb4;

CREATE TABLE usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(80) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  senha_hash VARCHAR(100) NOT NULL,
  saldo_centavos BIGINT NOT NULL,
  capital_inicial_centavos BIGINT NOT NULL,
  agente TINYINT NOT NULL DEFAULT 0,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE ativos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticker VARCHAR(8) NOT NULL UNIQUE,
  nome VARCHAR(80) NOT NULL,
  preco_centavos BIGINT NOT NULL,
  preco_abertura_centavos BIGINT NOT NULL,
  volume BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE posicoes (
  usuario_id INT NOT NULL,
  ativo_id INT NOT NULL,
  quantidade INT NOT NULL,
  quantidade_reservada INT NOT NULL DEFAULT 0,
  preco_medio_centavos BIGINT NOT NULL,
  PRIMARY KEY (usuario_id, ativo_id),
  CONSTRAINT fk_posicao_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
  CONSTRAINT fk_posicao_ativo FOREIGN KEY (ativo_id) REFERENCES ativos(id)
) ENGINE=InnoDB;

CREATE TABLE ordens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  usuario_id INT NOT NULL,
  ativo_id INT NOT NULL,
  lado ENUM('compra', 'venda') NOT NULL,
  quantidade INT NOT NULL,
  quantidade_restante INT NOT NULL,
  preco_centavos BIGINT NOT NULL,
  status ENUM('aberta', 'parcial', 'executada', 'cancelada', 'rejeitada') NOT NULL,
  criada_em TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ordem_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
  CONSTRAINT fk_ordem_ativo FOREIGN KEY (ativo_id) REFERENCES ativos(id),
  INDEX idx_livro (ativo_id, lado, status, preco_centavos, criada_em)
) ENGINE=InnoDB;

CREATE TABLE negociacoes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ativo_id INT NOT NULL,
  ordem_compra_id INT NOT NULL,
  ordem_venda_id INT NOT NULL,
  comprador_id INT NOT NULL,
  vendedor_id INT NOT NULL,
  quantidade INT NOT NULL,
  preco_centavos BIGINT NOT NULL,
  executada_em TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_negociacao_ativo (ativo_id, id),
  CONSTRAINT fk_neg_ativo FOREIGN KEY (ativo_id) REFERENCES ativos(id)
) ENGINE=InnoDB;

CREATE TABLE eventos (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  tipo VARCHAR(48) NOT NULL,
  ordem_id INT NULL,
  usuario_id INT NULL,
  detalhe JSON NULL,
  criado_em TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_evento_ordem (ordem_id, id)
) ENGINE=InnoDB;

INSERT INTO ativos (ticker, nome, preco_centavos, preco_abertura_centavos) VALUES
  ('CIAJ3', 'Cajuína do Sertão', 1850, 1850),
  ('PSER4', 'Petrosergipe', 3640, 3640),
  ('BSFR3', 'Banco do São Francisco', 2890, 2890),
  ('TXIN4', 'Têxtil Xingó', 1425, 1425);
