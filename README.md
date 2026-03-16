## WhatsApp Blast Pro

Aplicação em Node.js para envio em massa e agendamento de mensagens para grupos do WhatsApp, usando a biblioteca `@whiskeysockets/baileys` e uma interface web em tempo real com Socket.IO.

### Requisitos

- Node.js 18+ recomendado
- npm

### Instalação

```bash
npm install
```

### Execução

```bash
npm start
```

Depois abra o navegador em `http://localhost:3000`.

### Estrutura do projeto

- `server.js`  
  Ponto de entrada da aplicação. Sobe o servidor HTTP/Express/Socket.IO, agenda a rotina de autolimpeza e inicializa a conexão com o WhatsApp.

- `public/`  
  Front-end (HTML/CSS/JS) com:
  - Visualização do QR Code
  - Lista de grupos
  - Envio imediato de mensagens (texto + imagem)
  - Criação, edição e exclusão de agendamentos
  - Ferramenta de entrada automática em grupos via links de convite

- `agendador.js`  
  Responsável pela persistência (`agendamentos.json`) e pelo registro dos jobs de envio com `node-schedule`. Implementa:
  - Criação/edição/exclusão de agendamentos
  - Registro e recarga de jobs na inicialização
  - Compressão de imagens para envios agendados (via `sharp`)

- `src/cleanup.js`  
  Módulo de **autolimpeza automática** (cache, diretórios temporários, etc.), usado pelo `server.js` para rodar em intervalos regulares.

- `src/whatsapp.js`  
  Encapsula toda a conexão com o WhatsApp (Baileys):
  - Autenticação com `useMultiFileAuthState`
  - Reconexão automática
  - Tratamento de logout real (limpa `auth_info`)
  - Cache de grupos (`groupFetchAllParticipating`)
  - Integração com o agendador (`recarregarTodosJobs`)

- `src/socketHandlers.js`  
  Contém todos os **handlers do Socket.IO**, mantendo as funcionalidades originais:
  - `pedir-grupos`
  - `enviar` (blast imediato)
  - `listar-agendamentos`
  - `criar-agendamento`
  - `editar-agendamento`
  - `excluir-agendamento`
  - `join-groups` (entrada automática em grupos via link)
  - `desconectar` (logout manual)

### Boas práticas aplicadas

- Separação de responsabilidades:
  - conexão WhatsApp (`src/whatsapp.js`)
  - eventos de socket (`src/socketHandlers.js`)
  - rotina de limpeza (`src/cleanup.js`)
  - regras de negócio de agendamento (`agendador.js`)
- Tratamento de erros com mensagens claras para o front-end.
- Delays aleatórios entre envios para reduzir risco de rate-limit/ban.
- Compressão de imagens (envio imediato e agendado) para reduzir consumo de memória e tamanho das mensagens.

