# SQS Admin Panel

Painel web de administração do Amazon SQS — 100% serverless.

## Funcionalidades

- 📋 Listar filas (Standard + FIFO) com métricas em tempo real
- ➕ Criar / deletar filas
- ⚙️ Editar atributos (visibility timeout, retention, redrive policy)
- 🗑️ Purgar filas
- 📨 Enviar mensagens (com suporte a FIFO group/dedup ID e delay)
- 📦 Envio em batch (JSON array)
- 👁️ Peek de mensagens (visualizar sem remover da fila)
- ✏️ Editar o corpo da mensagem in place (peek-and-edit best-effort, race delete/send existe; preserva MessageAttributes, não todos os atributos SQS)
- 🔍 Filtro de mensagens por conteúdo
- ❌ Deletar mensagens individuais
- 🔄 Redrive de DLQ (reprocessar mensagens que falharam)
- 🔀 Mover mensagens entre filas (por `messageId`, com `MessageAttributes` preservados)
- ⏱️ Long polling com retries configuráveis para fetch confiável
- 📤 Export / Import de mensagens (JSON)
- 📊 Dashboard com KPIs e visão geral de todas as filas
- 🔐 Autenticação via Cognito (no deploy AWS)

## Arquitetura

- **Frontend**: React + Vite → S3 + CloudFront
- **Backend**: API Gateway + Lambda (Python) → AWS SAM
- **Auth**: Amazon Cognito User Pool
- **Local**: Docker Compose (LocalStack + Backend + Frontend)

## Setup Local

### Pré-requisito

- Docker

### Configurar o ambiente

Copie o arquivo de exemplo e escolha um modo:

```bash
cp .env.example .env
```

`.env.example` documenta dois modos:

- **Modo A — AWS SQS real**: deixe `SQS_ENDPOINT_URL` vazio e preencha
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (opcional,
  para SSO / role assumida) e `AWS_DEFAULT_REGION`. O backend conversa
  diretamente com a AWS.
- **Modo B — LocalStack** (desenvolvimento local padrão): defina
  `SQS_ENDPOINT_URL=http://localstack:4566` e use as credenciais dummy `test`.

> ⚠️ `SQS_ENDPOINT_URL` deve ser apenas o endpoint do serviço — nunca a URL
> de uma fila. Colocar a URL de uma fila causa
> `InvalidAction ... ListQueues is not valid for this endpoint`.

### Subir o ambiente

Modo A (AWS SQS real) — sobe apenas backend e frontend:

```bash
docker compose up --build -d backend frontend
```

Modo B (LocalStack) — sobe os três serviços:

```bash
docker compose --profile localstack up --build
```

Acesse `http://localhost:5173`. Pronto.

Serviços:
- **localstack** (porta 4566) — SQS emulado (somente Modo B)
- **backend** (porta 3001) — API Python que invoca o mesmo handler da Lambda
- **frontend** (porta 5173) — Vite dev server com proxy para o backend

> No ambiente local a autenticação é desabilitada automaticamente.

### Rodar testes

```bash
# Localmente (com containers já rodando)
bash tests.sh

# Via Docker (sobe tudo e roda os testes)
docker compose --profile test run --rm tests
```

Os testes cobrem: CRUD de filas, envio/recebimento, batch, export/import, move, DLQ/redrive, purge e delete.

## Deploy na AWS

### Pré-requisitos

- AWS CLI configurado
- AWS SAM CLI (`brew install aws-sam-cli`)
- Node.js 18+

### One-click deploy

```bash
./deploy.sh sqs-admin-panel admin@example.com
```

Parâmetros:
- `sqs-admin-panel` — nome do stack CloudFormation (opcional, default: `sqs-admin-panel`)
- `admin@example.com` — email do admin inicial (opcional, recebe senha temporária por email)

O script faz tudo automaticamente:
1. `sam build` + `sam deploy` (Lambda, API Gateway, Cognito, S3, CloudFront)
2. Build do frontend com as variáveis do Cognito e API URL
3. Upload do frontend pro S3
4. Exibe a URL do painel

### Deploy manual

```bash
# 1. Deploy do backend
sam build
sam deploy --guided

# 2. Copie os outputs (ApiUrl, UserPoolId, UserPoolClientId, FrontendBucket)

# 3. Build do frontend
cd frontend
VITE_API_URL=https://xxx.execute-api.us-east-1.amazonaws.com/api \
VITE_COGNITO_USER_POOL_ID=us-east-1_xxx \
VITE_COGNITO_CLIENT_ID=xxx \
  npm run build

# 4. Upload pro S3
aws s3 sync dist/ s3://BUCKET_NAME/ --delete
```

## Remover da AWS

```bash
./destroy.sh sqs-admin-panel
```

Esvazia o bucket S3 e deleta todo o stack CloudFormation (Lambda, API Gateway, Cognito, S3, CloudFront).

## Estrutura do Projeto

```
sqs_admin_painel/
├── backend/
│   ├── app.py              # Lambda handler — API completa do SQS
│   ├── local_server.py     # Servidor HTTP local que emula API Gateway
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx         # Componente principal (queue detail)
│   │   ├── App.css         # Estilos globais
│   │   ├── Dashboard.tsx   # Dashboard com KPIs e tabela de filas
│   │   ├── Dashboard.css   # Estilos do dashboard
│   │   ├── Login.tsx       # Tela de login (Cognito)
│   │   ├── api.ts          # Cliente HTTP para a API
│   │   ├── auth.ts         # Módulo de autenticação (Cognito)
│   │   ├── main.tsx        # Entry point com fluxo de auth
│   │   └── vite-env.d.ts
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── package.json
├── template.yaml           # SAM template (Lambda, API GW, Cognito, S3, CloudFront)
├── samconfig.toml
├── docker-compose.yml      # Ambiente local (LocalStack + Backend + Frontend + Tests)
├── deploy.sh               # Script de deploy one-click
├── destroy.sh              # Script de tear-down
├── tests.sh                # Testes de integração
├── .env.example            # Template de env local (Modo A: AWS real / Modo B: LocalStack)
├── .gitignore
└── README.md
```

## Variáveis de Ambiente (Frontend)

| Variável | Descrição | Obrigatória |
|---|---|---|
| `VITE_API_URL` | URL do API Gateway | Sim (deploy) |
| `VITE_COGNITO_USER_POOL_ID` | Cognito User Pool ID | Sim (deploy) |
| `VITE_COGNITO_CLIENT_ID` | Cognito App Client ID | Sim (deploy) |

> Quando as variáveis do Cognito não estão definidas, a autenticação é desabilitada (modo local).

## Variáveis de Ambiente (Backend / Local)

Carregadas automaticamente pelo `docker compose` a partir do `.env` na raiz
do projeto. Veja `.env.example` para o template completo.

| Variável | Descrição | Default |
|---|---|---|
| `SQS_ENDPOINT_URL` | Endpoint do serviço SQS. Vazio = AWS real; `http://localstack:4566` = LocalStack. **Nunca a URL de uma fila.** | _(vazio)_ |
| `AWS_ACCESS_KEY_ID` | AWS access key | `test` |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | `test` |
| `AWS_SESSION_TOKEN` | Session token (apenas para SSO / credenciais temporárias) | _(vazio)_ |
| `AWS_DEFAULT_REGION` | Região AWS onde estão as filas | `us-east-1` |

## Segurança

- API protegida por Cognito Authorizer (JWT)
- Frontend servido via CloudFront (HTTPS)
- S3 bucket privado (acesso apenas via CloudFront OAC)
- Lambda com policy `sqs:*` — intencional, pois é um painel de administração
- CORS configurado no API Gateway

## License

MIT
