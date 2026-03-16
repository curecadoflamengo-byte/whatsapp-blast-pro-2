const path = require("path");
const fs = require("fs");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const {
  recarregarTodosJobs
} = require("../agendador");

let sock = null;
let conectado = false;
let gruposCache = [];
let ioRef = null;

function setIo(io) {
  ioRef = io;
  global.io = io;
}

function getIo() {
  return ioRef || global.io;
}

function getSock() {
  return sock;
}

function isConectado() {
  return conectado && !!sock;
}

function getGruposCache() {
  return gruposCache;
}

async function carregarGrupos() {
  const io = getIo();
  try {
    const grupos = await sock.groupFetchAllParticipating();

    gruposCache = Object.entries(grupos)
      .map(([id, g]) => ({
        id,
        name: g.subject || "Grupo sem nome",
        participantes: g.participants?.length || 0
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (io) {
      io.emit("grupos", gruposCache);
      io.emit("status", `Conectado! ${gruposCache.length} grupos carregados`);
    }
  } catch (err) {
    console.error("[GRUPOS] Erro ao carregar:", err);
    if (io) {
      io.emit("status", "Erro ao carregar grupos. Tentando novamente...");
    }
    setTimeout(carregarGrupos, 5000);
  }
}

async function conectar() {
  const io = getIo();
  const authDir = path.join(__dirname, "..", "auth_info");

  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[BAILEYS] Usando versão do WhatsApp Web: ${version.join(".")}`);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      logger: pino({ level: "silent" }),
      markOnlineOnConnect: false,
      getMessage: async () => ({ conversation: "" })
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && io) {
        console.log("[QR] Novo QR gerado");
        io.emit("qr", qr);
        io.emit("status", "Escaneie o QR Code para conectar");
      }

      if (connection === "close") {
        conectado = false;
        sock = null;

        const error = lastDisconnect?.error;
        const statusCode = error?.output?.statusCode;

        console.log(`[DISCONNECT] Conexão fechada. Código: ${statusCode || "desconhecido"}`);
        console.log("[DISCONNECT] Detalhes do erro:", error);

        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          console.log(`[LOGOUT REAL] Detectado (status ${statusCode}). Limpando sessão.`);
          if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log("[LOGOUT] Pasta auth_info apagada");
          }
          if (io) {
            io.emit("status", "Sessão encerrada (logout). Escaneie novo QR.");
            io.emit("log", "Sessão perdida (logout no celular ou manual). Gerando novo QR...");
          }
          setTimeout(conectar, 2000);
          return;
        }

        if (statusCode === 405) {
          console.log("[405] Provável incompatibilidade de protocolo ou versão antiga.");
          if (io) {
            io.emit("status", "Erro 405 – atualizando conexão (pode ser versão do WA)...");
          }
          setTimeout(conectar, 8000);
          return;
        }

        if (io) {
          io.emit("status", "Desconectado temporariamente. Reconectando em alguns segundos...");
        }
        setTimeout(conectar, 4000);
      }

      if (connection === "open") {
        conectado = true;
        console.log("[CONECTADO] WhatsApp conectado com sucesso!");
        if (io) {
          io.emit("status", "Conectado! Carregando grupos...");
        }

        setTimeout(carregarGrupos, 3000);
        recarregarTodosJobs(sock);
      }
    });
  } catch (err) {
    console.error("[CONECTAR] Erro ao iniciar conexão:", err);
    if (io) {
      io.emit("erro", "Falha ao iniciar conexão: " + err.message);
    }
    setTimeout(conectar, 10000);
  }
}

function iniciarWhatsApp(io) {
  setIo(io);
  conectar();
}

module.exports = {
  iniciarWhatsApp,
  getSock,
  isConectado,
  getGruposCache,
  carregarGrupos
};

