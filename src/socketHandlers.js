const crypto = require("crypto");
const sharp = require("sharp");

const {
  criarAgendamento,
  carregarAgendamentos,
  editarAgendamento,
  excluirAgendamento
} = require("../agendador");

/**
 * Registra todos os handlers do Socket.IO.
 * Depende de funções passadas pelo módulo de WhatsApp para evitar globais.
 */
function registerSocketHandlers(io, { getSock, isConectado, getGruposCache, carregarGrupos }) {
  io.on("connection", (socket) => {
    console.log("Novo cliente conectado ao painel.");

    if (isConectado()) {
      socket.emit("status", "Conectado!");
    }

    const cache = getGruposCache();
    if (isConectado() && cache.length > 0) {
      socket.emit("grupos", cache);
    }

    socket.on("pedir-grupos", () => {
      const cacheAtual = getGruposCache();
      if (isConectado() && cacheAtual.length > 0) {
        socket.emit("grupos", cacheAtual);
      } else {
        socket.emit("status", "Carregando grupos...");
        if (isConectado()) {
          carregarGrupos().catch(() => {});
        }
      }
    });

    socket.on("enviar", async (payload) => {
      const sock = getSock();
      if (!isConectado() || !sock) {
        socket.emit("erro", "WhatsApp ainda não está conectado.");
        return;
      }

      const { gruposSelecionados = [], imagemBase64, texto = "" } = payload || {};

      if (!Array.isArray(gruposSelecionados) || gruposSelecionados.length === 0) {
        socket.emit("erro", "Nenhum grupo selecionado para envio.");
        return;
      }

      const mensagem = (texto || "").trim();
      if (!mensagem && !imagemBase64) {
        socket.emit("erro", "É necessário informar um texto ou uma imagem.");
        return;
      }

      console.log(`[ENVIO-AGORA] Enviando mensagem para ${gruposSelecionados.length} grupo(s).`);

      let imageBuffer = null;
      if (imagemBase64) {
        try {
          const buf = Buffer.from(imagemBase64.split(",")[1] || "", "base64");
          if (buf.length > 0) {
            imageBuffer = await sharp(buf)
              .resize(800, 800, { fit: "inside", withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toBuffer();
          }
        } catch (err) {
          console.error("[ENVIO-AGORA] Falha ao processar imagem, usando original se possível:", err.message);
          try {
            const buf = Buffer.from(imagemBase64.split(",")[1] || "", "base64");
            imageBuffer = buf.length > 0 ? buf : null;
          } catch {
            imageBuffer = null;
          }
        }
      }

      let ok = 0;
      let erro = 0;

      for (const gid of gruposSelecionados) {
        const currentSock = getSock();
        if (!currentSock?.user) {
          console.log("[ENVIO-AGORA] Conexão perdida no meio do envio. Abortando.");
          break;
        }

        const msg = imageBuffer
          ? { image: imageBuffer, caption: mensagem }
          : { text: mensagem };

        try {
          await currentSock.sendMessage(gid, msg);
          ok += 1;
          console.log(`[ENVIO-AGORA] OK → ${gid.split("@")[0]}`);
        } catch (err) {
          erro += 1;
          console.error(`[ENVIO-AGORA] FALHA → ${gid.split("@")[0]}:`, err.message);
        }

        await new Promise((resolve) => setTimeout(resolve, 700 + Math.floor(Math.random() * 800)));
      }

      socket.emit("finalizado", { ok, erro });
    });

    socket.on("listar-agendamentos", () => {
      try {
        const lista = carregarAgendamentos();
        socket.emit("agendamentos-list", lista);
      } catch (err) {
        console.error("[AGENDADOR] Erro ao listar agendamentos:", err);
        socket.emit("erro", "Erro ao carregar agendamentos.");
      }
    });

    socket.on("criar-agendamento", async (dados) => {
      try {
        const {
          gruposIds = [],
          texto = "",
          imagemBase64 = null,
          horarios = [],
          repetirDiariamente = false
        } = dados || {};

        if (!Array.isArray(gruposIds) || gruposIds.length === 0) {
          socket.emit("erro", "Selecione ao menos um grupo para o agendamento.");
          return;
        }
        if (!Array.isArray(horarios) || horarios.length === 0) {
          socket.emit("erro", "Informe ao menos um horário válido para o agendamento.");
          return;
        }

        const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString("hex");

        const agendamento = criarAgendamento({
          id,
          gruposIds,
          texto: (texto || "").trim(),
          imagemBase64,
          horarios,
          repetirDiariamente: !!repetirDiariamente,
          criadoEm: new Date().toISOString()
        });

        const currentSock = getSock();
        if (currentSock) {
          const { registrarJobs } = require("../agendador");
          registrarJobs(currentSock, agendamento);
        }

        io.emit("agendamento-ok", agendamento);
        console.log(`[AGENDADOR] Novo agendamento criado (${id}) para ${gruposIds.length} grupos.`);
      } catch (err) {
        console.error("[AGENDADOR] Erro ao criar agendamento:", err);
        socket.emit("erro", "Erro ao criar agendamento.");
      }
    });

    socket.on("editar-agendamento", async (dados) => {
      try {
        const {
          id,
          gruposIds = [],
          texto = "",
          imagemBase64 = null,
          horarios = [],
          repetirDiariamente = false
        } = dados || {};

        if (!id) {
          socket.emit("erro", "ID do agendamento não informado.");
          return;
        }
        if (!Array.isArray(gruposIds) || gruposIds.length === 0) {
          socket.emit("erro", "Selecione ao menos um grupo para o agendamento.");
          return;
        }
        if (!Array.isArray(horarios) || horarios.length === 0) {
          socket.emit("erro", "Informe ao menos um horário válido para o agendamento.");
          return;
        }

        const atualizado = editarAgendamento(id, {
          gruposIds,
          texto: (texto || "").trim(),
          imagemBase64,
          horarios,
          repetirDiariamente: !!repetirDiariamente
        });

        if (!atualizado) {
          socket.emit("erro", "Agendamento não encontrado.");
          return;
        }

        const currentSock = getSock();
        if (currentSock) {
          const { registrarJobs } = require("../agendador");
          registrarJobs(currentSock, atualizado);
        }

        io.emit("agendamento-editado", atualizado);
        console.log(`[AGENDADOR] Agendamento ${id} atualizado.`);
      } catch (err) {
        console.error("[AGENDADOR] Erro ao editar agendamento:", err);
        socket.emit("erro", "Erro ao editar agendamento.");
      }
    });

    socket.on("excluir-agendamento", (id) => {
      try {
        if (!id) {
          socket.emit("erro", "ID do agendamento não informado.");
          return;
        }

        const ok = excluirAgendamento(id);
        if (!ok) {
          socket.emit("erro", "Agendamento não encontrado.");
          return;
        }

        io.emit("agendamento-excluido", id);
        console.log(`[AGENDADOR] Agendamento ${id} excluído.`);
      } catch (err) {
        console.error("[AGENDADOR] Erro ao excluir agendamento:", err);
        socket.emit("erro", "Erro ao excluir agendamento.");
      }
    });

    socket.on("join-groups", async (links = []) => {
      const sock = getSock();
      if (!isConectado() || !sock) {
        socket.emit("erro", "WhatsApp não está conectado para entrar em grupos.");
        return;
      }

      if (!Array.isArray(links) || links.length === 0) {
        socket.emit("erro", "Nenhum link informado.");
        return;
      }

      const validLinks = links
        .map((l) => (l || "").trim())
        .filter((l) => l.startsWith("https://chat.whatsapp.com/"));

      if (validLinks.length === 0) {
        socket.emit("erro", "Nenhum link de convite válido encontrado.");
        return;
      }

      console.log(`[JOIN] Iniciando entrada em ${validLinks.length} grupos.`);
      io.emit("log", `[JOIN] Iniciando processo para ${validLinks.length} links...`);

      let ok = 0;
      let falha = 0;

      for (const link of validLinks) {
        const currentSock = getSock();
        if (!currentSock?.user) {
          io.emit("log", "[JOIN] Conexão perdida durante o processo. Interrompendo.");
          break;
        }

        try {
          const code = link.split("/").pop();
          if (!code) throw new Error("Código de convite inválido");

          if (typeof currentSock.groupAcceptInviteV4 === "function") {
            await currentSock.groupAcceptInviteV4(code);
          } else if (typeof currentSock.groupAcceptInvite === "function") {
            await currentSock.groupAcceptInvite(code);
          } else {
            throw new Error("Função de aceitar convite não disponível nesta versão");
          }

          ok += 1;
          io.emit("log", `[JOIN] OK: entrou em ${code}`);
        } catch (err) {
          falha += 1;
          io.emit("log", `[JOIN] FALHA para link: ${link} → ${err.message}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 2500 + Math.floor(Math.random() * 2000)));
      }

      io.emit("log", `[JOIN] Processo concluído. Sucesso: ${ok} | Falhas: ${falha}`);
    });

    socket.on("desconectar", async () => {
      const sock = getSock();
      if (!isConectado() || !sock) {
        socket.emit("status", "Já desconectado.");
        return;
      }

      console.log("[DESCONECTAR MANUAL] Usuário solicitou logout");

      try {
        await sock.logout();
        const path = require("path");
        const fs = require("fs");
        const authDir = path.join(__dirname, "..", "auth_info");
        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
          console.log("[DESCONECTAR] auth_info removida");
        }
        sock.ws?.close();

        io.emit("status", "Desconectado manualmente. Escaneie novo QR.");
        io.emit("log", "Conta desconectada manualmente.");

        const { iniciarWhatsApp } = require("./whatsapp");
        iniciarWhatsApp(io);
      } catch (err) {
        console.error("[DESCONECTAR] Erro:", err);
        io.emit("erro", "Erro ao desconectar: " + err.message);
      }
    });

    socket.on("disconnect", () => {
      console.log("Cliente desconectado do painel.");
    });
  });
}

module.exports = {
  registerSocketHandlers
};

