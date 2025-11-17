// server.js

const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
// ❌ Avant : const PORT = 3000;
// ✅ Après : PORT dynamique pour Railway + local
const PORT = process.env.PORT || 3000;

// Dossier pour les fichiers statiques (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Petite route de test API
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'AirLink' });
});

// ---- Gestion des sessions ----

// Stockage simple en mémoire (OK pour un MVP)
const sessions = {};

// Fonction pour générer un code (4 chiffres)
function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Route pour créer une session
app.post('/api/create-session', (req, res) => {
  const code = generateCode();
  sessions[code] = { createdAt: Date.now() };
  res.json({ code });
});

// Route pour rejoindre une session
app.post('/api/join-session', express.json(), (req, res) => {
  const { code } = req.body;

  if (!sessions[code]) {
    return res.status(404).json({ error: "Session introuvable" });
  }

  res.json({ ok: true, code });
});

// ---- Création du serveur HTTP & Socket.io ----
const server = http.createServer(app);
const io = new Server(server); // pas besoin de CORS car front et back sont sur le même domaine

io.on('connection', (socket) => {
  console.log('🔌 Nouveau client connecté :', socket.id);

  // Le client demande à rejoindre une session
  socket.on('join-session', (code) => {
    if (!sessions[code]) {
      console.log('❌ Tentative de rejoindre une session inconnue :', code);
      socket.emit('system-message', 'Session introuvable.');
      return;
    }

    socket.join(code);
    socket.data.sessionCode = code;

    console.log(`✅ Socket ${socket.id} a rejoint la session ${code}`);
    io.to(code).emit('system-message', `Un appareil a rejoint la session ${code}.`);
  });

  // Réception d’un message texte depuis un client
  socket.on('send-message', ({ code, text }) => {
    if (!code || !text) return;

    const payload = {
      text,
      from: socket.id,
      timestamp: Date.now()
    };

    io.to(code).emit('message', payload);
  });

  // ---- Nouveau système de fichiers en CHUNKS ----

  // Métadonnées du fichier (nom, taille, type, id...)
  socket.on('file-meta', (payload) => {
    const { code } = payload;
    if (!code) return;

    const enriched = {
      ...payload,
      from: socket.id,
      timestamp: Date.now()
    };

    // On renvoie à tous les clients de la session
    io.to(code).emit('file-meta', enriched);
  });

  // Un chunk de fichier (ArrayBuffer)
  socket.on('file-chunk', (payload) => {
    const { code } = payload;
    if (!code) return;

    // On relaye tel quel aux autres (et à l’émetteur)
    io.to(code).emit('file-chunk', payload);
  });

  // Indique que tous les chunks ont été envoyés
  socket.on('file-complete', (payload) => {
    const { code } = payload;
    if (!code) return;

    const enriched = {
      ...payload,
      from: socket.id,
      timestamp: Date.now()
    };

    io.to(code).emit('file-complete', enriched);
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client déconnecté :', socket.id);
  });
});

// ✅ PORT dynamique (Railway ou local)
server.listen(PORT, () => {
  console.log(`✅ AirLink backend + WebSocket lancé sur le port ${PORT}`);
});
