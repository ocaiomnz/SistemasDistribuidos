# Pregão Norte

Simulador de bolsa multiplayer da disciplina de Sistemas Distribuídos. Vários investidores entram no mesmo mercado, enviam ordens limitadas e acompanham o livro de ofertas em tempo real.

A stack é Node.js, Express, EJS e MySQL. Tudo sobe com Docker.

## Subir o mercado

Na pasta `projetos/bolsa`:

```powershell
docker compose up --build
```

Abra [http://localhost:3000](http://localhost:3000). Cadastre dois investidores em navegadores diferentes (ou uma janela normal e uma anônima). Cada conta começa com R$ 100.000,00.

Os ativos iniciais são CIAJ3, PSER4, BSFR3 e TXIN4. Ana Conservadora e Bruno Agressivo já operam sozinhos para o livro não ficar parado.

## O que dá para demonstrar

- Cadastro, login e sessão que sobrevive ao reinício do servidor.
- Envio de compra e venda, com saldo ou quantidade reservados na hora.
- Livro ordenado por preço e, no empate, pela ordem mais antiga.
- Negócio quando a compra alcança a venda. O preço executado é o da ordem que já estava no livro.
- Atualização do Home Broker por Server-Sent Events. Se a aba cair, o navegador reconecta sozinho.
- Cancelamento de ordem aberta, com devolução do que ficou reservado.
- Métricas em `GET /metricas` e logs JSON no terminal do contêiner `pregao`.

## Perfil ADMIN

O servidor cria a conta `admin@bolsa.local` com a senha `admin123` (mude em `ADMIN_EMAIL` e `ADMIN_SENHA`). Entrando com ela, o topo ganha quatro abas:

- **Logs**: logs estruturados ao vivo, encadeados por SHA-256. O navegador recalcula o hash de cada linha que chega e acusa qualquer registro editado ("Simular adulteração" demonstra). A mesma tela traz o monitoramento dos serviços (latência, ordens/s, CPU, event loop, MySQL, fila, breakers), o rastreio de uma ordem de `ORDER_RECEIVED` até `CLIENTS_NOTIFIED` e as sondas de segurança, que atacam a própria API com uma conta comum e mostram cada ataque barrado.
- **Mundo**: notícias boas ou ruins por ação (ou para o mercado inteiro), manuais ou sorteadas. Cada notícia muda o valor justo da empresa e a confiança dos robôs, que passam a comprar abaixo do valor que enxergam e vender acima. A tela mostra preço contra valor justo, a confiança de cada papel, quem está ganhando e perdendo (por conta e por estratégia), o índice "comprar e segurar" e a razão caixa ÷ ações. "Recomeçar rodada" leva os preços ao valor justo e redistribui o capital dos robôs entre caixa e ações.
- **O Caos**: circuit breaker do mercado (manual por ativo, mercado inteiro ou automático por variação), breaker do serviço com falha de banco injetada, alavancagem com chamada de margem, roleta de fortuna e quebra, e baleias que acumulam um papel, inflam o preço, despejam e sacam.
- **Admin**: cria N perfis de robô com estratégias sorteadas (conservador, agressivo, momentum, contrarian, aleatório, formador de mercado), controla o ritmo dos agentes, dispara testes de carga por HTTP e mostra o ranking. No fim da página, "Zerar o mercado (FLUSH)" apaga ordens, negócios, eventos, notícias, posições, robôs, baleias e contas de carga, volta preços e valor justo ao lançamento, zera breakers, caos e mundo e recomeça os IDs do 1. Pede para digitar `FLUSH`; opcionalmente apaga também as contas humanas (o ADMIN fica). Os logs da aba Logs são mantidos como auditoria.

Investidores comuns que tentam abrir essas páginas recebem 403 e a tentativa vai para o log de segurança.

## Ver o banco

O Compose sobe o [Adminer](http://localhost:8081) junto com o mercado. Entre com sistema **MySQL**, servidor `mysql`, usuário `bolsa`, senha `bolsa` e base `bolsa`. Dá para navegar pelas tabelas, filtrar registros e rodar SQL em "SQL command".

Pelo terminal, sem instalar nada:

```powershell
docker compose exec mysql mysql -ubolsa -pbolsa bolsa
```

Dentro do prompt, consultas úteis:

```sql
SHOW TABLES;
SELECT ticker, preco_centavos, fundamento_centavos FROM ativos;
SELECT id, nome, perfil, estado, saldo_centavos FROM usuarios ORDER BY id DESC LIMIT 20;
SELECT * FROM ordens ORDER BY id DESC LIMIT 20;
SELECT * FROM negociacoes ORDER BY id DESC LIMIT 20;
SELECT tipo, ordem_id, detalhe FROM eventos ORDER BY id DESC LIMIT 20;
SELECT * FROM noticias ORDER BY id DESC;
```

Para uma consulta só, sem abrir o prompt: `docker compose exec -T mysql mysql -ubolsa -pbolsa bolsa -e "SELECT * FROM ativos"`. De fora do Docker (DBeaver, Workbench, extensão do VS Code), conecte em `localhost:3308` com `bolsa`/`bolsa`.

Para apagar o banco inteiro e recriar a partir do `sql/init.sql` (perde também as contas humanas e o ADMIN é recriado no boot): `docker compose down -v` e depois `docker compose up --build`.

## Falha controlada

Com uma ordem ainda aberta:

```powershell
docker compose stop pregao
docker compose start pregao
```

O processo some, a sessão e as ordens continuam no MySQL, e o Home Broker volta a receber eventos depois que o contêiner sobe de novo.

## Carga

Com o mercado no ar, em outro terminal:

```powershell
node scripts/carga.js --usuarios 5 --ordens 2
```

O script cadastra investidores e envia compras simultâneas de CIAJ3. Ajuste `--usuarios` para 5, 20 ou 50. O resultado impresso traz aceitas, rejeitadas, duração e latência. A aba Admin faz o mesmo pelo navegador, com ordens mistas em todos os papéis, e grava cada execução na tabela `testes_carga`.

## Desenvolvimento sem Docker no app

O MySQL do Compose fica publicado em `localhost:3308` (as portas 3306 e 3307 já costumam estar ocupadas nesta máquina). Para rodar só o Node na máquina, suba o banco com `docker compose up mysql` e copie `.env.example` para `.env`:

```powershell
npm install
npm start
```

Há uma réplica da aplicação de propósito. A fila em memória define a ordem total das ordens; duas réplicas duplicariam os agentes e perderiam essa ordem.
