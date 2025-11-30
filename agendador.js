// agendador.js — COM COMPRESSÃO AUTOMÁTICA DE IMAGEM (evita erro de memória)

const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");
const sharp = require("sharp"); // ← adicionado apenas esta linha

const DB_PATH = path.join(__dirname, "agendamentos.json");
let jobs = {}; // jobs[id] = array de objetos { job, dateKey }

function carregarDB() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, "[]");
  const raw = fs.readFileSync(DB_PATH, "utf8");
  try {
    const data = JSON.parse(raw);
    return data.map(ag => {
      if (!ag.horarios && ag.data) {
        ag.horarios = [{ data: ag.data }];
        delete ag.data;
      }
      return ag;
    });
  } catch {
    return [];
  }
}

function salvarDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function criarAgendamento(ag) {
  const db = carregarDB();
  if (!ag.horarios || !Array.isArray(ag.horarios)) {
    ag.horarios = [{ data: ag.dataISO }];
  }
  db.push(ag);
  salvarDB(db);
  return ag;
}

function editarAgendamento(id, alteracoes) {
  const db = carregarDB();
  const idx = db.findIndex(a => a.id === id);
  if (idx === -1) return null;

  if (jobs[id]) {
    jobs[id].forEach(entry => {
      if (entry && entry.job && typeof entry.job.cancel === 'function') {
        entry.job.cancel();
      }
    });
    delete jobs[id];
  }

  const atualizado = { ...db[idx], ...alteracoes };
  db[idx] = atualizado;
  salvarDB(db);
  return atualizado;
}

function excluirAgendamento(id) {
  const db = carregarDB();
  const idx = db.findIndex(a => a.id === id);
  if (idx === -1) return false;

  if (jobs[id]) {
    jobs[id].forEach(entry => {
      if (entry && entry.job && typeof entry.job.cancel === 'function') {
        entry.job.cancel();
      }
    });
    delete jobs[id];
  }

  db.splice(idx, 1);
  salvarDB(db);
  return true;
}

function registrarJobs(sock, agendamento) {
  const { id, gruposIds, horarios = [], texto, imagemBase64, repetirDiariamente = false } = agendamento;

  if (!Array.isArray(horarios) || horarios.length === 0) return;

  if (jobs[id]) {
    jobs[id].forEach(entry => {
      if (entry?.job?.cancel) entry.job.cancel();
    });
  }
  jobs[id] = [];

const jobFunction = async () => {
  if (!sock?.user) {
    console.log(`[AGEND ${id}] WhatsApp desconectado no início. Abortando.`);
    return;
  }

  console.log(`[BLAST ${id}] Iniciando envio SEGURO para ${gruposIds.length} grupos (versão IMORTAL)`);

  let sucessos = 0;
  let falhas = 0;

  // COMPRESSÃO DA IMAGEM (só uma vez)
  let imageBuffer = null;
  if (imagemBase64) {
    try {
      const buf = Buffer.from(imagemBase64.split(",")[1], "base64");
      imageBuffer = await sharp(buf)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch (e) { /* se falhar, usa original */ }
  }

  // LOOP COM RECONEXÃO AUTOMÁTICA + TIMEOUT POR ENVIO
  for (let i = 0; i < gruposIds.length; i++) {
    const grupoId = gruposIds[i];

    // VERIFICA SE AINDA ESTÁ CONECTADO (a cada envio!)
    if (!sock?.user) {
      console.log(`[RECONECTANDO] Conexão perdida no envio ${sucessos + falhas + 1}/${gruposIds.length}. Reconectando...`);
      io.emit("log", `[RECONECTANDO] Bot desconectado durante blast. Tentando reconectar...`);
      
      // Espera o sock voltar (máximo 30s)
      let tentativas = 0;
      while (!sock?.user && tentativas < 30) {
        await new Promise(r => setTimeout(r, 1000));
        tentativas++;
      }

      if (!sock?.user) {
        console.log(`[FALHA CRÍTICA] Não conseguiu reconectar. Abortando blast.`);
        io.emit("log", `[ERRO] Não foi possível reconectar ao WhatsApp. Blast interrompido.`);
        return;
      }
      console.log(`[RECONECTADO] Conexão restaurada! Continuando do envio ${sucessos + falhas + 1}...`);
      io.emit("log", `[RECONECTADO] Conexão restaurada! Continuando blast...`);
    }

    let enviado = false;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        const msg = imageBuffer
          ? { image: imageBuffer, caption: texto || "" }
          : { text: texto || "" };

        // TIMEOUT DE 15 SEGUNDOS POR ENVIO
        await Promise.race([
          sock.sendMessage(grupoId, msg),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000))
        ]);

        sucessos++;
        console.log(`[OK] ${sucessos}/${gruposIds.length} → ${grupoId.split('@')[0]}`);
        enviado = true;
        break;

      } catch (err) {
        if (tentativa === 3) {
          falhas++;
          console.log(`[FALHOU] ${grupoId.split('@')[0]} → ${err.message}`);
        } else if (err.message.includes('timeout') || err.message.includes('rate')) {
          console.log(`[TENTATIVA ${tentativa}] Timeout/rate-limit em ${grupoId.split('@')[0]}. Tentando novamente...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    // DELAY HUMANO (ajustado para máximo de entrega)
    const delay = 800 + Math.floor(Math.random() * 1200); // 0.8 a 2.0 segundos
    await new Promise(r => setTimeout(r, delay));
  }

  console.log(`[CONCLUÍDO] Blast FINALIZADO: ${sucessos}/${gruposIds.length} enviados (${falhas} falharam)`);
  if (global.io) {
    global.io.emit("log", `[SUCESSO] Blast concluído: ${sucessos}/${gruposIds.length} mensagens entregues!`);
  }
};

  horarios.forEach((h, index) => {
    const date = new Date(h.data);
    if (isNaN(date.getTime())) return;

    if (repetirDiariamente) {
      const rule = new schedule.RecurrenceRule();
      rule.hour = date.getHours();
      rule.minute = date.getMinutes();
      rule.second = 0;

      const job = schedule.scheduleJob(rule, jobFunction);
      if (job) {
        jobs[id].push({ job, type: 'daily', hour: date.getHours(), minute: date.getMinutes() });
        console.log(`[RECORRÊNCIA ${id}-${index}] Todo dia às ${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`);
      }
    } else {
      if (date > new Date()) {
        const job = schedule.scheduleJob(date, jobFunction);
        if (job) {
          jobs[id].push({ job, type: 'once', date: date.toISOString() });
          console.log(`[ÚNICO ${id}-${index}] Agendado para ${date.toLocaleString()}`);
        }
      }
    }
  });
}

function recarregarTodosJobs(sock) {
  Object.keys(jobs).forEach(id => {
    if (jobs[id]) {
      jobs[id].forEach(entry => entry?.job?.cancel());
    }
  });
  jobs = {};

  const db = carregarDB();
  db.forEach(ag => registrarJobs(sock, ag));
  console.log(`[BOOT] Recarregados ${db.length} agendamento(s) com sucesso.`);
}

function carregarAgendamentos() {
  return carregarDB();
}

module.exports = {
  criarAgendamento,
  editarAgendamento,
  excluirAgendamento,
  registrarJobs,
  recarregarTodosJobs,
  carregarAgendamentos
};