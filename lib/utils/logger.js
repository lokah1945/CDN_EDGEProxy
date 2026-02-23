const fs = require('fs');
const path = require('path');

const logDir = path.resolve('./logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, 'edge-proxy.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function format(level, msg) {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}] ${msg}`;
}

const logger = {
  info(msg) { const l = format('INFO', msg); console.log(l); logStream.write(l + '\n'); },
  warn(msg) { const l = format('WARN', msg); console.warn(l); logStream.write(l + '\n'); },
  error(msg) { const l = format('ERROR', msg); console.error(l); logStream.write(l + '\n'); }
};

module.exports = logger;
