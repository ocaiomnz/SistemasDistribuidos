import base64
import json
import os
import time

import pika

FILA_IMAGENS = "dcompany.imagens"
EXCHANGE_CONVERTIDAS = "dcompany.convertidas"
EXCHANGE_FANOUT = "fanout"


def configuracao():
    return {
        "host": os.environ.get("RABBITMQ_HOST", "localhost"),
        "user": os.environ.get("RABBITMQ_USER", "dcompany"),
        "password": os.environ.get("RABBITMQ_PASS", "dcompany"),
    }


def conectar():
    cfg = configuracao()
    ultimo_erro = None
    for tentativa in range(1, 31):
        try:
            parametros = pika.ConnectionParameters(
                host=cfg["host"],
                credentials=pika.PlainCredentials(cfg["user"], cfg["password"]),
                heartbeat=600,
                blocked_connection_timeout=300,
            )
            conexao = pika.BlockingConnection(parametros)
            canal = conexao.channel()
            preparar_topologia(canal)
            return conexao, canal
        except Exception as erro:
            ultimo_erro = erro
            print(f"Aguardando RabbitMQ ({tentativa}/30): {erro}", flush=True)
            time.sleep(2)
    raise RuntimeError(f"Não foi possível conectar ao RabbitMQ: {ultimo_erro}")


def preparar_topologia(canal):
    canal.queue_declare(queue=FILA_IMAGENS, durable=True)
    canal.exchange_declare(
        exchange=EXCHANGE_CONVERTIDAS,
        exchange_type=EXCHANGE_FANOUT,
        durable=True,
    )


def fila_armazenamento(identificador):
    return f"dcompany.armazenamento.{identificador}"


def empacotar(nome, conteudo):
    return json.dumps(
        {
            "nome": nome,
            "conteudo_b64": base64.b64encode(conteudo).decode("ascii"),
        }
    ).encode("utf-8")


def desempacotar(corpo):
    mensagem = json.loads(corpo.decode("utf-8"))
    nome = os.path.basename(mensagem["nome"])
    if not nome or nome in {".", ".."}:
        raise ValueError("Nome de arquivo inválido")
    conteudo = base64.b64decode(mensagem["conteudo_b64"])
    return nome, conteudo


def publicar(canal, exchange, routing_key, corpo):
    canal.basic_publish(
        exchange=exchange,
        routing_key=routing_key,
        body=corpo,
        properties=pika.BasicProperties(
            content_type="application/json",
            delivery_mode=pika.DeliveryMode.Persistent,
        ),
    )
