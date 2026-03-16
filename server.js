const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { agendarAutoLimpeza } = require("./src/cleanup");
const {
  iniciarWhatsApp,
  getSock,
  isConectado,
  getGruposCache,
  carregarGrupos
} = require("./src/whatsapp");
const { registerSocketHandlers } = require("./src/socketHandlers");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

global.io = io;

app.use(express.static("public"));

agendarAutoLimpeza(io);

iniciarWhatsApp(io);

registerSocketHandlers(io, {
  getSock,
  isConectado,
  getGruposCache,
  carregarGrupos
});

server.listen(3000, () => {
  console.log("Servidor rodando → http://localhost:3000");
});