const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const pino = require("pino");
const { exec } = require("child_process");

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
//  AUTOLIMPEZA AUTOMÁTICA (a cada 4h + após blast grande)
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
//  CONEXÃO DO BAILEYS
// ===============================================================
async function conectar() {
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

    if (qr) io.emit("qr", qr);

    if (connection === "close") {
      conectado = false;
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
//  CARREGAR OS GRUPOS E SALVAR NO CACHE
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
//  SOCKET.IO - COMUNICAÇÃO COM FRONT
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
});

// ===============================================================
//  INICIAR SERVIDOR
// ===============================================================
conectar();
server.listen(3000, () => console.log("Acesse http://localhost:3000"));