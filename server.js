const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const pino = require("pino");
const { exec } = require("child_process");
const fs = require("fs"); // ← Necessário para apagar auth_info

// IMPORTAÇÕES CORRIGIDAS E COMPLETAS
const {
  criarAgendamento,
  carregarAgendamentos,
  editarAgendamento,
  excluirAgendamento,
  registrarJobs,
  recarregarTodosJobs
} = require("./agendador");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
global.io = io;

app.use(express.static("public"));

let sock;
let conectado = false;

// CACHE DE GRUPOS
let gruposCache = [];

// ===============================================================
// AUTOLIMPEZA AUTOMÁTICA (a cada 4h + após blast grande)
// ===============================================================
function autoLimpeza() {
  console.log("[AUTOLIMPEZA Iniciando limpeza automática de memória e cache...");
  // Força coleta de lixo do Node.js
  if (global.gc) global.gc();

  const comandos = [
    `powershell -Command "Remove-Item -Path '$env:TEMP\\*' -Recurse -Force -ErrorAction SilentlyContinue"`,
    `powershell -Command "Remove-Item -Path 'C:\\Windows\\Temp\\*' -Recurse -Force -ErrorAction SilentlyContinue"`,
    `powershell -Command "Remove-Item -Path '$env:USERPROFILE\\AppData\\Local\\npm-cache\\*' -Recurse -Force -ErrorAction SilentlyContinue"`,
    `powershell -Command "Remove-Item -Path '.\\node_modules\\.cache\\' -Recurse -Force -ErrorAction SilentlyContinue" 2>$null`,
    `npm cache clean --force`
  ];

  comandos.forEach(cmd => {
    exec(cmd, { windowsHide: true }, (err) => {
      if (err && !err.message.includes("não encontrado") && !err.message.includes("The system cannot find")) {
        // ignora erros comuns
      }
    });
  });

  if (global.io) {
    global.io.emit("log", "LIMPEZA Cache e memória limpos automaticamente");
  }
  console.log("[AUTOLIMPEZA] Limpeza concluída!\n");
}

// Roda limpeza a cada 4 horas
setInterval(autoLimpeza, 4 * 60 * 60 * 1000);

// Primeira limpeza 10 segundos após conectar
setTimeout(autoLimpeza, 10000);

// Exporta função para o agendador usar após blast grande
global.autoLimpeza = autoLimpeza;

// ===============================================================
// CONEXÃO DO BAILEYS
// ===============================================================
async function conectar() {
  const authDir = path.join(__dirname, "auth_info");

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false,
    shouldIgnoreJid: jid => true,
    getMessage: async () => ({ conversation: '' })
  });
  
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      io.emit("qr", qr);
      io.emit("status", "Escaneie o QR Code para conectar");
    }

    if (connection === "close") {
      conectado = false;
      sock = null; // Limpa referência antiga

      const statusCode = lastDisconnect?.error?.output?.statusCode;

      // Logout manual, logout no celular ou credenciais removidas → força novo QR
      if (
        statusCode === 401 || 
        statusCode === 405 || 
        !fs.existsSync(authDir)
      ) {
        console.log(`[LOGOUT] Detectado (status ${statusCode || 'creds ausentes'}). Gerando novo QR Code.`);

        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
          console.log("[LOGOUT] Pasta auth_info apagada");
        }

        io.emit("status", "Sessão encerrada. Escaneie o novo QR Code.");
        io.emit("log", "Sessão perdida (logout no celular ou manual). Gerando novo QR...");

        // Reinicia conexão para gerar QR imediatamente
        setTimeout(conectar, 2000);
        return;
      }

      // Outros casos (queda de rede, erro temporário) → reconecta automaticamente
      io.emit("status", "Desconectado. Reconectando...");
      setTimeout(conectar, 4000);
    }

    if (connection === "open") {
      conectado = true;
      io.emit("status", "Conectado! Carregando grupos...");

      setTimeout(carregarGrupos, 3000);

      recarregarTodosJobs(sock);
    }
  });
}

// ===============================================================
// CARREGAR OS GRUPOS E SALVAR NO CACHE
// ===============================================================
async function carregarGrupos() {
  try {
    const grupos = await sock.groupFetchAllParticipating();

    gruposCache = Object.entries(grupos).map(([id, g]) => ({
      id,
      name: g.subject || "Grupo sem nome",
      participantes: g.participants?.length || 0
    })).sort((a, b) => a.name.localeCompare(b.name));

    io.emit("grupos", gruposCache);
    io.emit("status", `Conectado! ${gruposCache.length} grupos carregados`);
  } catch (err) {
    io.emit("status", "Erro ao carregar grupos. Tentando novamente...");
    setTimeout(carregarGrupos, 5000);
  }
}

// ===============================================================
// SOCKET.IO - COMUNICAÇÃO COM FRONT
// ===============================================================
io.on("connection", (socket) => {
  console.log("Novo cliente conectado ao painel.");

  if (conectado) {
    socket.emit("status", "Conectado!");
  }

  if (conectado && gruposCache.length > 0) {
    console.log("Mandando grupos ao novo cliente");
    socket.emit("grupos", gruposCache);
  }

  socket.on("pedir-grupos", () => {
    console.log("Cliente pediu lista de grupos.");
    if (conectado && gruposCache.length > 0) {
      socket.emit("grupos", gruposCache);
    } else {
      socket.emit("status", "Carregando grupos...");
    }
  });

  // ENVIO INSTANTÂNEO
  socket.on("enviar", async (data) => {
    if (!conectado) return socket.emit("erro", "WhatsApp não conectado");

    const { gruposSelecionados, imagemBase64, texto } = data;

    socket.emit("enviando", gruposSelecionados.length);

    const envios = gruposSelecionados.map(id =>
      sock.sendMessage(id, {
        image: imagemBase64 ? Buffer.from(imagemBase64.split(",")[1], "base64") : undefined,
        caption: texto
      })
        .then(() => ({ id, status: "ok" }))
        .catch(() => ({ id, status: "erro" }))
    );

    const results = await Promise.all(envios);
    const ok = results.filter(r => r.status === "ok").length;
    const erro = results.filter(r => r.status === "erro").length;

    socket.emit("finalizado", { ok, erro });

    // Limpeza automática após envio instantâneo grande
    if (gruposSelecionados.length > 300) {
      setTimeout(autoLimpeza, 10000);
    }
  });

  // LISTAR AGENDAMENTOS
  socket.on("listar-agendamentos", () => {
    const ags = carregarAgendamentos();
    socket.emit("agendamentos-list", ags);
  });

  socket.on("editar-agendamento", (dados) => {
    const { id, gruposIds, texto, imagemBase64, horarios, repetirDiariamente } = dados;

    const alteracoes = {};
    if (gruposIds !== undefined) alteracoes.gruposIds = gruposIds;
    if (texto !== undefined) alteracoes.texto = texto;
    if (imagemBase64 !== undefined) alteracoes.imagemBase64 = imagemBase64;
    if (horarios !== undefined) alteracoes.horarios = horarios;
    if (repetirDiariamente !== undefined) alteracoes.repetirDiariamente = repetirDiariamente;

    const atualizado = editarAgendamento(id, alteracoes);
    if (atualizado) {
      registrarJobs(sock, atualizado);
      io.emit("agendamento-editado", atualizado);
    } else {
      socket.emit("erro", "Agendamento não encontrado");
    }
  });

  socket.on("excluir-agendamento", (id) => {
    const sucesso = excluirAgendamento(id);

    if (sucesso) {
      io.emit("agendamento-excluido", id);
    } else {
      socket.emit("erro", "Agendamento não encontrado");
    }
  });

  // BOTÃO DESCONECTAR CONTA
  socket.on("desconectar", async () => {
    if (!conectado || !sock) {
      socket.emit("status", "Já desconectado ou não conectado.");
      return;
    }

    console.log("[DESCONECTAR] Usuário solicitou desconexão manual");

    try {
      await sock.logout();

      const authDir = path.join(__dirname, "auth_info");
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log("[DESCONECTAR] Pasta auth_info apagada com sucesso");
      }

      sock.ws.close();
      sock = null;
      conectado = false;

      io.emit("status", "Desconectado com sucesso. Escaneie o novo QR Code.");
      io.emit("log", "Conta desconectada manualmente. Novo QR Code gerado.");

      // Reinicia conexão para gerar QR imediatamente
      setTimeout(conectar, 2000);

    } catch (err) {
      console.log("[DESCONECTAR] Erro ao desconectar:", err);
      io.emit("erro", "Erro ao desconectar a conta: " + err.message);
    }
  });

  socket.on("criar-agendamento", (data) => {
    const { gruposIds, texto, imagemBase64, horarios, repetirDiariamente = false } = data;

    if (!Array.isArray(gruposIds) || gruposIds.length === 0) {
      return socket.emit("erro", "Selecione pelo menos um grupo");
    }
    if (!Array.isArray(horarios) || horarios.length === 0) {
      return socket.emit("erro", "Adicione pelo menos um horário");
    }

    const novoAgendamento = {
      id: crypto.randomUUID(),
      gruposIds,
      texto,
      imagemBase64: imagemBase64 || null,
      horarios,
      repetirDiariamente,
      criadoEm: new Date().toISOString()
    };

    criarAgendamento(novoAgendamento);
    registrarJobs(sock, novoAgendamento);
    io.emit("agendamento-ok", novoAgendamento);
  });

   // NOVA FUNCIONALIDADE MELHORADA: ENTRADA AUTOMATIZADA EM GRUPOS VIA LINKS (VERIFICAÇÃO CORRIGIDA)
  socket.on("join-groups", async (links) => {
    if (!conectado) return socket.emit("erro", "WhatsApp não conectado");

    links = links.map(l => l.trim()).filter(l => l.startsWith("https://chat.whatsapp.com/"));
    if (links.length === 0) return socket.emit("erro", "Nenhum link válido encontrado");

    if (links.length > 3000) {
      return socket.emit("erro", "Limite de segurança: máximo 3000 links por execução. Divida em lotes menores.");
    }

    const total = links.length;
    let sucessos = 0;
    let falhas = 0;
    let jaEsta = 0;

    // Captura o estado do cache ANTES de começar os joins
    const gruposAntes = [...gruposCache.map(g => g.id)];

    socket.emit("log", `🚀 Iniciando entrada automática em ${total} grupo(s)...`);
    console.log(`\n[JOINS] Iniciando processo para ${total} grupos`);

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const index = i + 1;
      const code = link.split("https://chat.whatsapp.com/")[1];

      socket.emit("log", `📍 Processando ${index}/${total}: ${link.substring(0, 3000)}...`);
      console.log(`[JOINS ${index}/${total}] Tentando entrar: ${code}`);

      let groupId = null;
      let entrado = false;

      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        try {
          groupId = await sock.groupAcceptInvite(code);
          entrado = true;
          console.log(`[RESPOSTA API] AcceptInvite retornou: ${groupId} (tentativa ${tentativa})`);
          break;
        } catch (err) {
          const erroMsg = err.message || err.toString();
          if (tentativa < 3) {
            socket.emit("log", `⚠️ Tentativa ${tentativa}/3 falhou: ${erroMsg} → Tentando novamente...`);
            console.log(`[TENTATIVA ${tentativa}] Falha em ${code}: ${erroMsg}`);
            await new Promise(r => setTimeout(r, 5000 + Math.random() * 3000));
          } else {
            falhas++;
            socket.emit("log", `❌ Falha definitiva (${index}/${total}): ${erroMsg}`);
            console.log(`[FALHA] Não conseguiu entrar em ${code}: ${erroMsg}`);
          }
        }
      }

      if (entrado && groupId) {
        // Verifica se esse groupId JÁ EXISTIA antes dessa tentativa
        if (gruposAntes.includes(groupId)) {
          jaEsta++;
          socket.emit("log", `✅ Já estava nesse grupo → Pulando (${index}/${total})`);
          console.log(`[PULADO] Já estava no grupo ${groupId}`);
        } else {
          sucessos++;
          socket.emit("log", `✅ Entrou com sucesso! (NOVO GRUPO) (${index}/${total}) → ${groupId.split('@')[0]}`);
          console.log(`[SUCESSO NOVO] Entrou no grupo: ${groupId}`);
        }

        // Atualiza cache imediatamente para batches longos
        await carregarGrupos();
        // Atualiza a lista de "antes" para as próximas iterações
        gruposAntes.push(groupId);
      }

      // Delay humano entre joins
      if (i < links.length - 1) {
        const delay = 20000 + Math.floor(Math.random() * 15000);
        const delaySeg = Math.round(delay / 1000);
        socket.emit("log", `⏳ Aguardando ${delaySeg}s antes do próximo grupo...`);
        console.log(`[DELAY] Aguardando ${delaySeg}s`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    // Resumo final
    const resumo = `🎉 Processo concluído: ${sucessos}/${total} grupos NOVOS entrados`;
    const detalhes = `(${jaEsta} já estava no início, ${falhas} falharam)`;

    socket.emit("log", resumo);
    socket.emit("log", detalhes);
    console.log(`\n[RESUMO FINAL] ${sucessos}/${total} novos sucessos | ${jaEsta} já estava | ${falhas} falhas\n`);

    // Recarrega grupos uma última vez
    await carregarGrupos();

    if (total > 20) {
      setTimeout(autoLimpeza, 10000);
      socket.emit("log", "🧹 Executando limpeza automática de memória...");
    }
  });
});

// ===============================================================
// INICIAR SERVIDOR
// ===============================================================
conectar();
server.listen(3000, () => console.log("Acesse http://localhost:3000"));