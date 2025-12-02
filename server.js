// server.js

require('dotenv').config();

const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios'); // ✅ Mailjet via HTTP

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Limites version gratuite ----
const FREE_MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 Mo
const FREE_MAX_FILES_PER_SESSION = 5;        // 5 fichiers / session

// ---- Config Mailjet (API HTTP, pas SMTP) ----
const MAILJET_API_KEY = process.env.MAILJET_API_KEY || '';
const MAILJET_SECRET_KEY = process.env.MAILJET_SECRET_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@airlink.local';

if (!MAILJET_API_KEY || !MAILJET_SECRET_KEY) {
  console.log('📧 Mailjet non configuré (MAILJET_API_KEY / MAILJET_SECRET_KEY manquants).');
} else {
  console.log('📧 Mailjet configuré via API HTTP.');
}

// Fonction utilitaire pour envoyer un mail via Mailjet API
async function sendMailjetEmail({ toEmail, subject, html, text }) {
  if (!MAILJET_API_KEY || !MAILJET_SECRET_KEY) {
    console.log('📧 Mailjet désactivé : pas de clés API.');
    return { ok: false, reason: 'no_api_keys' };
  }

  const auth = Buffer.from(`${MAILJET_API_KEY}:${MAILJET_SECRET_KEY}`).toString('base64');

  const payload = {
    Messages: [
      {
        From: {
          Email: FROM_EMAIL,
          Name: 'AirLink',
        },
        To: [{ Email: toEmail }],
        Subject: subject,
        TextPart: text,
        HTMLPart: html,
      },
    ],
  };

  await axios.post('https://api.mailjet.com/v3.1/send', payload, {
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  return { ok: true };
}

// ---- Static ----
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'AirLink' });
});

// ---- Sessions en mémoire ----
const sessions = {};

function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Créer une session
app.post('/api/create-session', express.json(), (req, res) => {
  const { password } = req.body || {};
  const code = generateCode();

  sessions[code] = {
    createdAt: Date.now(),
    password: password || null,
    fileCount: 0,
  };

  res.json({ code });
});

// Rejoindre une session
app.post('/api/join-session', express.json(), (req, res) => {
  const { code, password } = req.body || {};
  const session = sessions[code];

  if (!session) {
    return res.status(404).json({ error: 'Session introuvable' });
  }

  if (session.password && session.password !== password) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }

  res.json({ ok: true, code });
});

// ---- Envoyer un lien de téléchargement par e-mail ----
// Pour l’instant : on envoie un mail avec le lien de la session.
// Plus tard, quand on aura un stockage, ce sera une vraie "page de dossier" valable X jours.
app.post('/api/send-invite', express.json(), async (req, res) => {
  const { sessionCode, toEmail, fromUserEmail } = req.body || {};

  if (!sessionCode || !toEmail) {
    return res.status(400).json({ error: 'Données manquantes.' });
  }

  if (!sessions[sessionCode]) {
    return res.status(404).json({ error: 'Session introuvable.' });
  }

  // (MVP) sécurité très simple : on exige que le front envoie fromUserEmail
  // => donc qu’il soit connecté avec Google.
  if (!fromUserEmail) {
    return res.status(401).json({ error: 'Utilisateur non authentifié.' });
  }

  const baseUrl =
    process.env.PUBLIC_BASE_URL ||
    req.headers.origin ||
    `http://localhost:${PORT}`;

  const link = `${baseUrl}?code=${sessionCode}`;

  const subject = 'Fichiers partagés via AirLink';
  const text =
    `Bonjour,\n\n` +
    `${fromUserEmail} t’a partagé des fichiers via AirLink.\n\n` +
    `Clique sur ce lien pour les récupérer : ${link}\n\n` +
    `Le lien peut expirer après un certain temps ou si la session est fermée.\n\n` +
    `— AirLink`;

  const html = `
    <p>Bonjour,</p>
    <p><strong>${fromUserEmail}</strong> t’a partagé des fichiers via <strong>AirLink</strong>.</p>
    <p>
      <a href="${link}" target="_blank" rel="noopener"
         style="display:inline-block;padding:10px 16px;border-radius:999px;
                background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;">
        Ouvrir la page de téléchargement
      </a>
    </p>
    <p style="font-size:12px;color:#64748b;">
      Le lien peut expirer après un certain temps ou si la session est fermée.
    </p>
  `;

  try {
    const result = await sendMailjetEmail({
      toEmail,
      subject,
      html,
      text,
    });

    if (!result.ok) {
      return res.status(500).json({ error: 'Mailjet non configuré.' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Erreur envoi e-mail d'invitation :", err?.response?.data || err);
    res.status(500).json({ error: "Erreur lors de l'envoi de l'e-mail." });
  }
});

// ---- WebSocket / temps réel ----
const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
  console.log('🔌 Client connecté :', socket.id);

  socket.on('join-session', (code) => {
    if (!sessions[code]) {
      socket.emit('system-message', 'Session introuvable.');
      return;
    }

    socket.join(code);
    socket.data.sessionCode = code;

    io.to(code).emit(
      'system-message',
      `Un appareil a rejoint la session ${code}.`
    );
  });

  socket.on('send-message', ({ code, text }) => {
    if (!code || !text) return;

    io.to(code).emit('message', {
      text,
      from: socket.id,
      timestamp: Date.now(),
    });
  });

  // ---- Fichiers ----
  socket.on('file-meta', (payload) => {
    const { code, fileSize } = payload;
    const session = sessions[code];

    if (!session) {
      socket.emit('file-error', 'Session introuvable.');
      return;
    }

    if (fileSize > FREE_MAX_FILE_SIZE) {
      socket.emit('file-error', 'Limite gratuite : max 20 Mo.');
      return;
    }

    if (session.fileCount >= FREE_MAX_FILES_PER_SESSION) {
      socket.emit(
        'file-error',
        'Limite gratuite : max 5 fichiers par session.'
      );
      return;
    }

    session.fileCount++;

    io.to(code).emit('file-meta', {
      ...payload,
      from: socket.id,
      timestamp: Date.now(),
    });
  });

  socket.on('file-chunk', (payload) => {
    io.to(payload.code).emit('file-chunk', payload);
  });

  socket.on('file-complete', (payload) => {
    io.to(payload.code).emit('file-complete', {
      ...payload,
      from: socket.id,
      timestamp: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client déconnecté :', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`✅ AirLink lancé sur le port ${PORT}`);
});
