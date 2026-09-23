// Basit JSON dosya deposu: kullanicilar, gateway'ler ve gonderim gecmisi
// tek bir data/db.json dosyasinda tutulur. Birkac gateway / birkac kullanici
// icin veritabani sunucusuna gerek yok; Coolify'da DATA_DIR bir kalici
// volume'a (persistent storage) baglanmali, yoksa her deploy'da sifirlanir.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const HISTORY_LIMIT = 500;

let data = { users: [], gateways: [], history: [] };

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    data = {
      users: parsed.users || [],
      gateways: parsed.gateways || [],
      history: parsed.history || [],
    };
  }
}

// Yazmalari kisa bir sure biriktirip tek seferde (once gecici dosyaya, sonra
// rename ile) yaziyoruz - yarim kalan yazma db.json'u bozmasin.
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 200);
}
function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---- Kullanicilar ----
function listUsers() { return data.users; }
function findUser(username) { return data.users.find((u) => u.username === username); }
function addUser(user) { data.users.push(user); save(); return user; }
function deleteUser(username) {
  data.users = data.users.filter((u) => u.username !== username);
  save();
}

// ---- Gateway'ler ----
function listGateways() { return data.gateways; }
function findGateway(id) { return data.gateways.find((g) => g.id === id); }
function addGateway(gw) { data.gateways.push(gw); save(); return gw; }
function deleteGateway(id) {
  data.gateways = data.gateways.filter((g) => g.id !== id);
  save();
}

// ---- Gonderim gecmisi (en yeni basta) ----
function addHistory(entry) {
  data.history.unshift(entry);
  if (data.history.length > HISTORY_LIMIT) data.history.length = HISTORY_LIMIT;
  save();
}
function listHistory(limit) { return data.history.slice(0, limit); }

module.exports = {
  load, save, flush,
  listUsers, findUser, addUser, deleteUser,
  listGateways, findGateway, addGateway, deleteGateway,
  addHistory, listHistory,
};
