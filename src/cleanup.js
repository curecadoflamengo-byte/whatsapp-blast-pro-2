const { exec } = require("child_process");

/**
 * Limpeza periódica de cache/temporários para evitar acúmulo de lixo
 * Mantém a lógica original, apenas organizada em módulo próprio.
 */
function autoLimpeza(io) {
  console.log("[AUTOLIMPEZA] Iniciando limpeza automática de memória e cache...");
  if (global.gc) global.gc();

  const comandos = [
    `powershell -Command "Remove-Item -Path '$env:TEMP\\*' -Recurse -Force -ErrorAction SilentlyContinue"`,
    `powershell -Command "Remove-Item -Path 'C:\\Windows\\Temp\\*' -Recurse -Force -ErrorAction SilentlyContinue"`,
    `powershell -Command "Remove-Item -Path '$env:USERPROFILE\\AppData\\Local\\npm-cache\\*' -Recurse -Force -ErrorAction SilentlyContinue"`,
    `powershell -Command "Remove-Item -Path '.\\node_modules\\.cache\\' -Recurse -Force -ErrorAction SilentlyContinue" 2>$null`,
    `npm cache clean --force`
  ];

  comandos.forEach((cmd) => {
    exec(cmd, { windowsHide: true }, (err) => {
      if (err && !err.message.includes("não encontrado") && !err.message.includes("The system cannot find")) {
        // erros comuns são ignorados de propósito
      }
    });
  });

  if (io) {
    io.emit("log", "LIMPEZA: Cache e memória limpos automaticamente");
  } else if (global.io) {
    global.io.emit("log", "LIMPEZA: Cache e memória limpos automaticamente");
  }

  console.log("[AUTOLIMPEZA] Limpeza concluída!\n");
}

/**
 * Agenda a limpeza automática exatamente como no código original.
 */
function agendarAutoLimpeza(io) {
  setInterval(() => autoLimpeza(io), 4 * 60 * 60 * 1000);
  setTimeout(() => autoLimpeza(io), 10000);
}

module.exports = {
  autoLimpeza,
  agendarAutoLimpeza
};

