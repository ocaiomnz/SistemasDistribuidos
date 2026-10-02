import { randomUUID } from "node:crypto";
import mqtt from "mqtt";

const pendentes = new Map();

export const TOPICOS = {
  "cadastrar-condutor": "denatran/condutores/cadastrar",
  transferir: "denatran/condutores/transferir",
  emplacar: "denatran/veiculos/emplacar",
  ipva: "denatran/veiculos/ipva",
  "veiculos-por-ano": "denatran/veiculos/por-ano",
  multar: "denatran/multas/lancar",
  "multas-veiculo": "denatran/multas/por-veiculo",
  "multas-condutor": "denatran/multas/por-condutor",
  "multas-ano": "denatran/multas/por-ano",
  top5: "denatran/multas/top5",
};

export function urlMqtt() {
  return process.env.MQTT_URL || "mqtt://127.0.0.1:1883";
}

export async function conectar(nome) {
  const url = urlMqtt();
  const cliente = mqtt.connect(url, {
    clientId: `${nome}-${randomUUID()}`,
    reconnectPeriod: 1000,
    connectTimeout: 10000,
  });

  let ativo = false;
  cliente.on("reconnect", () => {
    console.log(`[${nome}] tentando reconectar em ${url}`);
  });
  cliente.on("close", () => {
    if (!ativo) {
      return;
    }
    ativo = false;
    console.log(`[${nome}] desconectado de ${url}`);
  });
  cliente.on("error", (erro) => {
    console.error(`[${nome}] falha na conexão: ${erro.message}`);
  });

  await new Promise((resolve, reject) => {
    const aoConectar = () => {
      cliente.off("error", aoFalhar);
      ativo = true;
      console.log(`[${nome}] conectado em ${url}`);
      resolve();
    };
    const aoFalhar = (erro) => {
      cliente.off("connect", aoConectar);
      reject(erro);
    };
    cliente.once("connect", aoConectar);
    cliente.once("error", aoFalhar);
  });

  return cliente;
}

export function instalarDespacho(cliente, aoPedido) {
  cliente.on("message", (topico, payload) => {
    const pendente = pendentes.get(topico);
    if (pendente) {
      pendentes.delete(topico);
      pendente(payload);
      return;
    }
    if (aoPedido) {
      aoPedido(topico, payload);
    }
  });
}

export function rpc(cliente, topico, dados = {}, timeoutMs = 8000) {
  const correlationId = randomUUID();
  const replyTo = `denatran/resposta/${correlationId}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendentes.delete(replyTo);
      cliente.unsubscribe(replyTo);
      reject(new Error(`Tempo esgotado em ${topico}`));
    }, timeoutMs);

    pendentes.set(replyTo, (payload) => {
      clearTimeout(timer);
      cliente.unsubscribe(replyTo);
      let mensagem;
      try {
        mensagem = JSON.parse(payload.toString());
      } catch {
        reject(new Error("Resposta inválida do barramento"));
        return;
      }
      if (!mensagem.ok) {
        reject(new Error(mensagem.erro || "Falha no serviço"));
        return;
      }
      resolve(mensagem.dados);
    });

    cliente
      .subscribeAsync(replyTo, { qos: 1 })
      .then(() =>
        cliente.publishAsync(
          topico,
          JSON.stringify({ correlationId, replyTo, dados }),
          { qos: 1 }
        )
      )
      .catch((erro) => {
        clearTimeout(timer);
        pendentes.delete(replyTo);
        reject(erro);
      });
  });
}

function publicarResposta(cliente, pedido, corpo) {
  if (!pedido?.replyTo) {
    return;
  }
  const mensagem = {
    correlationId: pedido.correlationId,
    ...corpo,
  };
  cliente.publish(pedido.replyTo, JSON.stringify(mensagem), { qos: 1 });
}

export function tratarPedido(cliente, prefixo, handlers, topico, payload) {
  if (!topico.startsWith(`${prefixo}/`)) {
    return Promise.resolve();
  }

  let pedido = null;
  return Promise.resolve()
    .then(async () => {
      pedido = JSON.parse(payload.toString());
      const acao = topico.slice(prefixo.length + 1);
      const handler = handlers[acao];
      if (!handler) {
        throw new Error(`Ação desconhecida: ${acao}`);
      }
      const dados = await handler(pedido.dados || {});
      publicarResposta(cliente, pedido, { ok: true, dados });
    })
    .catch((erro) => {
      if (pedido?.replyTo) {
        publicarResposta(cliente, pedido, { ok: false, erro: erro.message });
        return;
      }
      console.error(`[${prefixo}] ${erro.message}`);
    });
}

export async function subirServico(nome, prefixo, criarHandlers) {
  const cliente = await conectar(nome);
  const handlers = criarHandlers(cliente);
  instalarDespacho(cliente, (topico, payload) => {
    tratarPedido(cliente, prefixo, handlers, topico, payload);
  });
  await cliente.subscribeAsync(`${prefixo}/+`, { qos: 1 });
  console.log(`[${nome}] escutando ${prefixo}/+ em ${urlMqtt()}`);
  return cliente;
}
