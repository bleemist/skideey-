const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fetch = require("node-fetch").default;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const ADMIN_PASSWORD = "Muyanja@6872@";

// In-memory stores (lost on server restart – fine for MVP)
const uuidToSocket = new Map();
let waitingUser = null;

// Monitoring globals
let emojiCount = {};
let countryCount = {};
let skipiesValues = [];

// Topic queues
const topicQueues = new Map();           // topic → Set<socket.id>
const noTopicWaiting = [];               // array of socket.ids with no topics

const reactionConfig = {
  "👍": { delta: 6, friends: 1 },
  "❤️": { delta: 9, friends: 1 },
  "🔥": { delta: 7, friends: 1 },
  "😂": { delta: 5, friends: 1 },
  "👏": { delta: 6, friends: 1 },
  "👎": { delta: -6, enemies: 1 },
  "😡": { delta: -9, enemies: 1 },
  "💀": { delta: -8, enemies: 1 }
};

io.on("connection", async (socket) => {
  const ip = socket.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim() || socket.handshake.address;

  // Fetch country server-side
  let country = "Unknown";
  try {
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    const data = await res.json();
    country = data.country_name || "Unknown";
  } catch {}
  socket.country = country;
  countryCount[country] = (countryCount[country] || 0) + 1;

  // Session stats
  socket.stats = { skipies: 50, friends: 0, enemies: 0 };
  socket.daily = { date: "", gained: 0 };
  socket.myTopics = [];

  uuidToSocket.set(socket.id, socket);

  // ─── Admin login ────────────────────────────────────────────────
  socket.on("adminLogin", (pass) => {
    if (pass === ADMIN_PASSWORD) {
      socket.join("admin");
      socket.emit("adminLoginSuccess");
      sendAdminStats();
    }
  });

  socket.on("requestAdminStats", () => {
    if (socket.rooms.has("admin")) sendAdminStats();
  });

  // ─── Join random with optional topics ──────────────────────────
  socket.on("joinRandom", ({ topics = [] }) => {
    socket.myTopics = Array.isArray(topics) ? topics.slice(0, 3) : [];

    // Clean old queues
    clearUserFromQueues(socket.id);

    if (socket.myTopics.length > 0) {
      socket.myTopics.forEach(t => {
        if (!topicQueues.has(t)) topicQueues.set(t, new Set());
        topicQueues.get(t).add(socket.id);
      });
      tryMatchByTopic(socket);
    } else {
      noTopicWaiting.push(socket.id);
      tryMatchAny();
    }
  });

  // ─── Skip ──────────────────────────────────────────────────────
  socket.on("skipRandom", () => {
    if (socket.partner) {
      socket.partner.emit("partnerLeft");
      socket.partner.partner = null;
      // Put partner back in queue
      socket.partner.emit("joinRandom", { topics: socket.partner.myTopics });
    }
    socket.partner = null;

    // Put self back in queue
    socket.emit("joinRandom", { topics: socket.myTopics });
  });

  // ─── Reactions ─────────────────────────────────────────────────
  socket.on("sendReaction", (data) => {
    const target = uuidToSocket.get(data.targetUuid) || socket.partner;
    if (!target || !target.stats || !reactionConfig[data.emoji]) return;

    const cfg = reactionConfig[data.emoji];

    // Daily cap (UTC day)
    const today = new Date().toISOString().split("T")[0];
    if (target.daily.date !== today) {
      target.daily = { date: today, gained: 0 };
    }
    if (target.daily.gained >= 12 && cfg.delta > 0) return;

    let current = target.stats.skipies;
    let gain = cfg.delta;

    // Diminishing returns near cap
    if (current >= 70)      gain = Math.max(1, Math.floor(gain * 0.25));
    else if (current >= 65) gain = Math.max(1, Math.floor(gain * 0.5));
    else if (current >= 55) gain = Math.floor(gain * 0.75);

    let newVal = Math.max(30, Math.min(80, current + gain));

    if (cfg.friends) target.stats.friends++;
    if (cfg.enemies) target.stats.enemies++;

    target.stats.skipies = newVal;
    if (gain > 0) target.daily.gained += gain;

    // Track emoji usage
    if (data.emoji) {
      emojiCount[data.emoji] = (emojiCount[data.emoji] || 0) + 1;
    }

    target.emit("statsUpdated", target.stats);

    // Update skipies list for admin
    skipiesValues = Array.from(uuidToSocket.values())
      .filter(s => s.stats)
      .map(s => s.stats.skipies);
  });

  // ─── Messages ──────────────────────────────────────────────────
  socket.on("publicMessage", (data) => {
    io.emit("publicMessage", {
      name: data.name || "Anonymous",
      message: data.message,
      senderUuid: data.senderUuid
    });
  });

  socket.on("randomMessage", (data) => {
    if (socket.partner) {
      socket.partner.emit("randomMessage", {
        name: data.name || "Anonymous",
        message: data.message,
        senderUuid: data.senderUuid
      });
    }
  });

  // ─── GIF proxy ─────────────────────────────────────────────────
  socket.on("publicGif", async (data) => {
    if (!data.url || !data.url.startsWith("http")) return;
    const proxyUrl = `/proxy-image?url=${encodeURIComponent(data.url)}`;
    io.emit("publicMessage", {
      name: data.name || "Anonymous",
      message: `<img src="${proxyUrl}" width="150" alt="GIF">`,
      senderUuid: socket.id
    });
  });

  socket.on("randomGif", async (data) => {
    if (!socket.partner || !data.url || !data.url.startsWith("http")) return;
    const proxyUrl = `/proxy-image?url=${encodeURIComponent(data.url)}`;
    socket.partner.emit("randomMessage", {
      name: data.name || "Anonymous",
      message: `<img src="${proxyUrl}" width="150" alt="GIF">`,
      senderUuid: socket.id
    });
  });

  // ─── Report (basic) ────────────────────────────────────────────
  socket.on("report", () => {
    console.log(`Report from ${socket.country} (${socket.id})`);
  });

  // ─── Disconnect cleanup ────────────────────────────────────────
  socket.on("disconnect", () => {
    if (socket.country) {
      countryCount[socket.country] = Math.max(0, (countryCount[socket.country] || 0) - 1);
    }
    clearUserFromQueues(socket.id);
    uuidToSocket.delete(socket.id);
    if (socket === waitingUser) waitingUser = null;
    if (socket.partner) {
      socket.partner.emit("partnerLeft");
      socket.partner.partner = null;
    }
    skipiesValues = Array.from(uuidToSocket.values())
      .filter(s => s.stats)
      .map(s => s.stats.skipies);
  });
});

// ─── Matching helpers ─────────────────────────────────────────────
function clearUserFromQueues(socketId) {
  for (const queue of topicQueues.values()) queue.delete(socketId);
  const idx = noTopicWaiting.indexOf(socketId);
  if (idx !== -1) noTopicWaiting.splice(idx, 1);
}

function tryMatchByTopic(socket) {
  let bestPartnerId = null;
  let maxShared = 0;

  for (const [topic, ids] of topicQueues) {
    if (!socket.myTopics.includes(topic)) continue;
    for (const otherId of ids) {
      if (otherId === socket.id) continue;
      const other = uuidToSocket.get(otherId);
      if (!other || other.partner) continue;

      const shared = other.myTopics.filter(t => socket.myTopics.includes(t)).length;
      if (shared > maxShared) {
        maxShared = shared;
        bestPartnerId = otherId;
      }
    }
  }

  if (bestPartnerId) {
    const partner = uuidToSocket.get(bestPartnerId);
    if (partner) {
      pairUsers(socket, partner);
      return true;
    }
  }

  // No good match → try any
  tryMatchAny();
}

function tryMatchAny() {
  if (noTopicWaiting.length >= 2) {
    const id1 = noTopicWaiting.shift();
    const id2 = noTopicWaiting.shift();
    const s1 = uuidToSocket.get(id1);
    const s2 = uuidToSocket.get(id2);
    if (s1 && s2 && !s1.partner && !s2.partner) {
      pairUsers(s1, s2);
    }
  }
}

function pairUsers(s1, s2) {
  s1.partner = s2;
  s2.partner = s1;

  s1.emit("partnerStats", s2.stats);
  s2.emit("partnerStats", s1.stats);

  s1.emit("randomStart");
  s2.emit("randomStart");

  clearUserFromQueues(s1.id);
  clearUserFromQueues(s2.id);
}

// ─── Admin stats broadcaster ─────────────────────────────────────
function sendAdminStats() {
  const online = io.engine.clientsCount;

  const emojisSorted = Object.entries(emojiCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const countriesSorted = Object.entries(countryCount)
    .sort((a, b) => b[1] - a[1]);

  const avg = skipiesValues.length
    ? skipiesValues.reduce((a, b) => a + b, 0) / skipiesValues.length
    : 50;

  const max = skipiesValues.length ? Math.max(...skipiesValues) : 80;
  const high = skipiesValues.filter(v => v >= 70).length;

  io.to("admin").emit("adminStats", {
    online,
    emojis: Object.fromEntries(emojisSorted),
    countries: Object.fromEntries(countriesSorted),
    avgSkipies: Math.round(avg * 10) / 10,
    maxSkipies: Math.round(max),
    above70: high
  });
}

setInterval(() => {
  if (io.sockets.adapter.rooms.get("admin")?.size > 0) {
    sendAdminStats();
  }
}, 6000);

// ─── Image proxy route ─────────────────────────────────────────────
app.get("/proxy-image", async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith("http")) return res.status(400).send("Invalid URL");

  try {
    const response = await fetch(url, { redirect: "follow", timeout: 8000 });
    if (!response.ok) return res.status(400).send("Cannot fetch");

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return res.status(400).send("Not an image");

    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=3600");
    response.body.pipe(res);
  } catch (err) {
    res.status(500).send("Proxy error");
  }
});

server.listen(3000, () => {
  console.log("Skideey server running on port 3000");
  console.log("Main app: http://localhost:3000/");
  console.log("Admin panel: http://localhost:3000/admin.html");
});