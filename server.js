const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require('fs').promises;
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static("public"));

const ADMIN_PASSWORD = "Muyanja@6872@";

// ==================== FILE-BASED PERSISTENCE ====================
const DATA_FILE = path.join(__dirname, 'data', 'users.json');

// Ensure data directory exists
async function ensureDataDir() {
  const dataDir = path.join(__dirname, 'data');
  try {
    await fs.access(dataDir);
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
  }
}
ensureDataDir();

// Load users from file
async function loadUsers() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

// Save users to file
async function saveUsers(users) {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(users, null, 2));
    console.log('💾 Users saved to disk');
  } catch (err) {
    console.error('❌ Failed to save users:', err.message);
  }
}

// ==================== DATA STRUCTURES ====================
let userSessions = {};
let users = new Map(); // socket.id -> user data
let waitingUsers = new Set(); // Users waiting for random chat
let videoCallUsers = new Map(); // Users in video calls
const messageQueue = []; // Fast message queue
let onlineCount = 0;

// Monitoring
let emojiCount = {};
let countryCount = {};

// Load saved data on startup
(async () => {
  userSessions = await loadUsers();
  console.log(`📂 Loaded ${Object.keys(userSessions).length} saved users`);
})();

// Auto-save every 5 minutes
setInterval(async () => {
  await saveUsers(userSessions);
}, 300000);

// Save on shutdown
process.on('SIGINT', async () => {
  console.log('\n💾 Saving users before shutdown...');
  await saveUsers(userSessions);
  process.exit(0);
});

// ==================== REACTION CONFIG ====================
const reactionConfig = {
  "👍": { delta: 0.6, friends: 0 },
  "❤️": { delta: 0.9, friends: 1 },
  "🔥": { delta: 0.7, friends: 0 },
  "😂": { delta: 0.5, friends: 0 },
  "👏": { delta: 0.6, friends: 0 },
  "👎": { delta: -0.6, enemies: 0 },
  "😡": { delta: -0.9, enemies: 1 },
  "💀": { delta: -0.8, enemies: 0 }
};

// ==================== ICE SERVERS FOR WEBRTC ====================
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ]
};

// ==================== FAST MESSAGE PROCESSOR ====================
setInterval(() => {
  if (messageQueue.length === 0) return;
  
  const batch = messageQueue.splice(0, 100);
  
  for (const msg of batch) {
    const targetSocket = io.sockets.sockets.get(msg.to);
    if (targetSocket) {
      targetSocket.emit('randomMessage', {
        name: msg.senderName,
        message: msg.content,
        senderUuid: msg.from,
        timestamp: Date.now()
      });
    }
  }
}, 10);

// ==================== CLEANUP OLD DATA ====================
setInterval(() => {
  if (Object.keys(emojiCount).length > 100) {
    emojiCount = {};
  }
}, 3600000);

// ==================== SOCKET CONNECTION ====================
io.on("connection", async (socket) => {
  const startTime = Date.now();
  const ip = socket.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim() || socket.handshake.address;
  const deviceId = socket.handshake.auth?.deviceId || socket.handshake.headers['x-device-id'];
  
  console.log(`🔌 New connection: ${socket.id} (${ip})`);

  // ==================== GET OR CREATE USER ====================
  let user;
  let username;
  let isNewUser = false;
  
  if (deviceId && userSessions[deviceId]) {
    user = { ...userSessions[deviceId] };
    username = user.username;
    console.log(`🔄 Returning user: ${username} (SkiPies: ${user.stats.skipies}%)`);
  } else {
    isNewUser = true;
    username = `Skd${Math.floor(100000 + Math.random() * 900000)}`;
    user = {
      username,
      stats: { skipies: 50, friends: 0, enemies: 0 },
      daily: { date: "", gained: 0 },
      deviceId,
      ip,
      firstSeen: Date.now(),
      lastSeen: Date.now()
    };
    
    if (deviceId) {
      userSessions[deviceId] = user;
      saveUsers(userSessions);
    }
  }
  
  user.socketId = socket.id;
  user.lastSeen = Date.now();
  users.set(socket.id, user);
  
  // ==================== GET COUNTRY ====================
  let country = "Unknown";
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=country`);
    const data = await res.json();
    country = data.country || "Unknown";
  } catch (error) {
    console.log(`🌍 Country fetch failed for ${ip}:`, error.message);
  }
  
  user.country = country;
  countryCount[country] = (countryCount[country] || 0) + 1;
  
  onlineCount = users.size;
  io.emit("onlineUsers", onlineCount);
  
  socket.emit("userData", {
    id: socket.id,
    username: user.username,
    stats: user.stats,
    messages: [],
    isNewUser
  });

  console.log(`✅ ${isNewUser ? 'New' : 'Returning'} user connected in ${Date.now() - startTime}ms`);

  // ==================== ADMIN LOGIN ====================
  socket.on("adminLogin", (pass) => {
    if (pass === ADMIN_PASSWORD) {
      socket.join("admin");
      socket.emit("adminLoginSuccess", { token: "admin-token" });
      sendAdminStats();
      console.log(`👑 Admin logged in from ${ip}`);
    } else {
      socket.emit("adminLoginFailed");
    }
  });

  socket.on("requestAdminStats", () => {
    if (socket.rooms.has("admin")) sendAdminStats();
  });

  // ==================== USERNAME CHANGE ====================
  socket.on("changeUsername", async (newUsername) => {
    if (newUsername && newUsername.length >= 3 && newUsername.length <= 20) {
      const oldName = user.username;
      user.username = newUsername;
      
      if (user.deviceId) {
        userSessions[user.deviceId] = user;
        await saveUsers(userSessions);
      }
      
      socket.emit("usernameChanged", newUsername);
      console.log(`📝 Username changed: ${oldName} -> ${newUsername}`);
    }
  });

  // ==================== CANCEL SEARCH ====================
  socket.on("cancelSearch", () => {
    console.log(`❌ ${user.username} cancelled search`);
    waitingUsers.delete(socket.id);
    socket.emit("searchCancelled");
  });

  // ==================== JOIN RANDOM CHAT WITH VIDEO OPTION ====================
  socket.on("joinRandom", ({ topics = [], videoEnabled = false }) => {
    console.log(`🎲 ${user.username} looking for ${videoEnabled ? 'VIDEO' : 'TEXT'} chat`);
    
    waitingUsers.delete(socket.id);
    socket.videoEnabled = videoEnabled;
    
    let matched = null;
    
    for (const waitingId of waitingUsers) {
      const waitingSocket = io.sockets.sockets.get(waitingId);
      if (waitingSocket && waitingSocket !== socket) {
        if (waitingSocket.videoEnabled === videoEnabled) {
          matched = waitingSocket;
          break;
        }
      }
    }
    
    if (matched) {
      waitingUsers.delete(matched.id);
      
      socket.partner = matched.id;
      matched.partner = socket.id;
      
      const matchedUser = users.get(matched.id);
      
      socket.emit("partnerStats", {
        username: matchedUser.username,
        stats: matchedUser.stats,
        videoEnabled: videoEnabled
      });
      
      matched.emit("partnerStats", {
        username: user.username,
        stats: user.stats,
        videoEnabled: videoEnabled
      });
      
      if (videoEnabled) {
        const roomId = `${socket.id}-${matched.id}-${Date.now()}`;
        videoCallUsers.set(socket.id, { partner: matched.id, room: roomId });
        videoCallUsers.set(matched.id, { partner: socket.id, room: roomId });
        
        socket.emit("videoStart", { 
          roomId, 
          initiator: true,
          iceServers: iceServers 
        });
        
        matched.emit("videoStart", { 
          roomId, 
          initiator: false,
          iceServers: iceServers 
        });
        
        console.log(`✅ Paired ${user.username} with ${matchedUser.username} for VIDEO call`);
      } else {
        socket.emit("randomStart");
        matched.emit("randomStart");
        console.log(`✅ Paired ${user.username} with ${matchedUser.username} for TEXT chat`);
      }
    } else {
      waitingUsers.add(socket.id);
      console.log(`⏳ ${user.username} added to waiting queue (${waitingUsers.size} waiting)`);
      
      const position = Array.from(waitingUsers).indexOf(socket.id) + 1;
      socket.emit("waitingStatus", { 
        waitingCount: waitingUsers.size,
        position: position
      });
    }
  });

  // ==================== WEBRTC SIGNALING ====================
  socket.on("webrtc-offer", (data) => {
    if (socket.partner) {
      io.to(socket.partner).emit("webrtc-offer", {
        offer: data.offer,
        from: socket.id
      });
    }
  });

  socket.on("webrtc-answer", (data) => {
    if (socket.partner) {
      io.to(socket.partner).emit("webrtc-answer", {
        answer: data.answer,
        from: socket.id
      });
    }
  });

  socket.on("webrtc-ice-candidate", (data) => {
    if (socket.partner) {
      io.to(socket.partner).emit("webrtc-ice-candidate", {
        candidate: data.candidate,
        from: socket.id
      });
    }
  });

  socket.on("endVideoCall", () => {
    const callData = videoCallUsers.get(socket.id);
    if (callData && callData.partner) {
      io.to(callData.partner).emit("videoCallEnded");
      videoCallUsers.delete(socket.id);
      videoCallUsers.delete(callData.partner);
    }
    
    if (socket.partner) {
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) {
        partnerSocket.emit("partnerLeft");
        partnerSocket.partner = null;
      }
      socket.partner = null;
    }
  });

  // ==================== PUBLIC MESSAGE ====================
  socket.on("publicMessage", (data) => {
    if (!data.message || typeof data.message !== "string") return;
    if (data.message.length > 4000) {
      socket.emit("error", "Message too long (max 4000 chars)");
      return;
    }
    
    const filtered = data.message
      .replace(/fuck|shit|ass|bitch|cunt|nigger|faggot/gi, "***");
    
    io.emit("publicMessage", {
      name: user.username,
      message: filtered,
      senderUuid: socket.id,
      timestamp: Date.now()
    });
  });

  // ==================== RANDOM MESSAGE ====================
  socket.on("randomMessage", (data) => {
    if (!socket.partner) {
      socket.emit("error", "No partner connected");
      return;
    }
    
    if (!data.message || typeof data.message !== "string") return;
    if (data.message.length > 4000) {
      socket.emit("error", "Message too long (max 4000 chars)");
      return;
    }
    
    const filtered = data.message
      .replace(/fuck|shit|ass|bitch|cunt|nigger|faggot/gi, "***");
    
    const partnerSocket = io.sockets.sockets.get(socket.partner);
    if (partnerSocket) {
      partnerSocket.emit("randomMessage", {
        name: user.username,
        message: filtered,
        senderUuid: socket.id,
        timestamp: Date.now()
      });
    }
    
    socket.emit("randomMessage", {
      name: user.username,
      message: filtered,
      senderUuid: socket.id,
      timestamp: Date.now()
    });
  });

  // ==================== PUBLIC GIF ====================
  socket.on("publicGif", (data) => {
    if (!data.url || !data.url.startsWith("http")) return;
    
    io.emit("publicMessage", {
      name: user.username,
      message: `<img src="/proxy-image?url=${encodeURIComponent(data.url)}" style="max-width:200px; border-radius:10px;" loading="lazy">`,
      senderUuid: socket.id,
      timestamp: Date.now()
    });
  });

  // ==================== RANDOM GIF ====================
  socket.on("randomGif", (data) => {
    if (!socket.partner || !data.url || !data.url.startsWith("http")) return;
    
    const partnerSocket = io.sockets.sockets.get(socket.partner);
    if (partnerSocket) {
      partnerSocket.emit("randomMessage", {
        name: user.username,
        message: `<img src="/proxy-image?url=${encodeURIComponent(data.url)}" style="max-width:200px; border-radius:10px;" loading="lazy">`,
        senderUuid: socket.id,
        timestamp: Date.now()
      });
    }
    
    socket.emit("randomMessage", {
      name: user.username,
      message: `<img src="/proxy-image?url=${encodeURIComponent(data.url)}" style="max-width:200px; border-radius:10px;" loading="lazy">`,
      senderUuid: socket.id,
      timestamp: Date.now()
    });
  });

  // ==================== SEND REACTION ====================
  socket.on("sendReaction", (data) => {
    let targetId = data.targetUuid;
    
    if (data.targetUuid === "lastPartner" && socket.partner) {
      targetId = socket.partner;
    }
    
    const target = users.get(targetId);
    const sender = users.get(socket.id);
    
    if (!target || !reactionConfig[data.emoji]) return;
    
    const cfg = reactionConfig[data.emoji];
    const isSelf = targetId === socket.id;
    
    if (!isSelf) {
      const today = new Date().toISOString().split("T")[0];
      if (target.daily.date !== today) {
        target.daily = { date: today, gained: 0 };
      }
      
      if (!(target.daily.gained >= 12 && cfg.delta > 0)) {
        let gain = cfg.delta;
        
        if (target.stats.skipies >= 70) gain = Math.max(1, Math.floor(gain * 0.25));
        else if (target.stats.skipies >= 65) gain = Math.max(1, Math.floor(gain * 0.5));
        else if (target.stats.skipies >= 55) gain = Math.floor(gain * 0.75);
        
        target.stats.skipies = Math.max(30, Math.min(80, target.stats.skipies + gain));
        
        if (cfg.friends) target.stats.friends++;
        if (cfg.enemies) target.stats.enemies++;
        
        if (gain > 0) target.daily.gained += gain;
        
        if (target.deviceId) {
          userSessions[target.deviceId] = target;
        }
      }
    }
    
    emojiCount[data.emoji] = (emojiCount[data.emoji] || 0) + 1;
    
    if (targetId && !isSelf) {
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) {
        targetSocket.emit("reactionReceived", {
          emoji: data.emoji,
          from: sender.username,
          fromId: socket.id,
          targetId: targetId,
          isSelf: false,
          timestamp: Date.now()
        });
        
        targetSocket.emit("statsUpdated", target.stats);
      }
    }
    
    socket.emit("reactionReceived", {
      emoji: data.emoji,
      from: sender.username,
      fromId: socket.id,
      targetId: targetId,
      isSelf: isSelf,
      timestamp: Date.now()
    });
    
    if (isSelf) {
      socket.emit("statsUpdated", sender.stats);
    }
  });

  // ==================== SKIP RANDOM ====================
  socket.on("skipRandom", () => {
    console.log(`⏭️ ${user.username} skipped`);
    
    const callData = videoCallUsers.get(socket.id);
    if (callData) {
      io.to(callData.partner).emit("videoCallEnded");
      videoCallUsers.delete(socket.id);
      videoCallUsers.delete(callData.partner);
    }
    
    if (socket.partner) {
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) {
        partnerSocket.emit("partnerLeft");
        partnerSocket.partner = null;
        
        const partnerUser = users.get(socket.partner);
        if (partnerUser) {
          waitingUsers.add(socket.partner);
        }
      }
    }
    
    socket.partner = null;
  });

  // ==================== REPORT USER ====================
  socket.on("report", (data) => {
    const reportedId = socket.partner;
    if (!reportedId) {
      socket.emit("error", "No user to report");
      return;
    }
    
    const reportedUser = users.get(reportedId);
    console.log(`🚨 Report from ${user.username} against ${reportedUser?.username || 'unknown'}`);
    
    socket.emit("reportSubmitted", {
      message: "Report submitted. Thank you for keeping Skideey safe!"
    });
    
    io.to("admin").emit("userReported", {
      reporter: user.username,
      reported: reportedUser?.username,
      reason: data.reason || "Inappropriate behavior"
    });
  });

  // ==================== DISCONNECT ====================
  socket.on("disconnect", async () => {
    console.log(`🔌 Disconnected: ${user.username} (${socket.id})`);
    
    const callData = videoCallUsers.get(socket.id);
    if (callData) {
      io.to(callData.partner).emit("videoCallEnded");
      videoCallUsers.delete(socket.id);
      videoCallUsers.delete(callData.partner);
    }
    
    if (user.country) {
      countryCount[user.country] = Math.max(0, (countryCount[user.country] || 0) - 1);
    }
    
    waitingUsers.delete(socket.id);
    
    if (socket.partner) {
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) {
        partnerSocket.emit("partnerLeft");
        partnerSocket.partner = null;
      }
    }
    
    users.delete(socket.id);
    
    onlineCount = users.size;
    io.emit("onlineUsers", onlineCount);
    
    if (user.deviceId) {
      user.lastSeen = Date.now();
      userSessions[user.deviceId] = user;
      await saveUsers(userSessions);
    }
  });
});

// ==================== ADMIN STATS ====================
function sendAdminStats() {
  const online = users.size;
  const totalUsers = Object.keys(userSessions).length;
  
  const emojisSorted = Object.entries(emojiCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  
  const countriesSorted = Object.entries(countryCount)
    .sort((a, b) => b[1] - a[1]);
  
  const skipiesValues = Array.from(users.values())
    .map(u => u.stats?.skipies || 50);
  
  const avgSkipies = skipiesValues.length
    ? skipiesValues.reduce((a, b) => a + b, 0) / skipiesValues.length
    : 50;
  
  const maxSkipies = skipiesValues.length ? Math.max(...skipiesValues) : 80;
  const above70 = skipiesValues.filter(v => v >= 70).length;
  
  const videoCallCount = videoCallUsers.size / 2;
  
  io.to("admin").emit("adminStats", {
    online,
    totalUsers,
    emojis: Object.fromEntries(emojisSorted),
    countries: Object.fromEntries(countriesSorted),
    avgSkipies: Math.round(avgSkipies * 10) / 10,
    maxSkipies: Math.round(maxSkipies),
    above70,
    activeRooms: Math.floor((online - videoCallCount) / 2),
    videoCalls: videoCallCount,
    queueSize: messageQueue.length,
    waitingCount: waitingUsers.size
  });
}

setInterval(() => {
  if (io.sockets.adapter.rooms.get("admin")?.size > 0) {
    sendAdminStats();
  }
}, 5000);

// ==================== IMAGE PROXY ====================
app.get("/proxy-image", async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith("http")) {
    return res.status(400).send("Invalid URL");
  }

  try {
    const response = await fetch(url, { 
      redirect: "follow", 
      timeout: 5000,
      size: 5 * 1024 * 1024
    });
    
    if (!response.ok) {
      return res.status(400).send("Cannot fetch");
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      return res.status(400).send("Not an image");
    }

    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.set("X-Content-Type-Options", "nosniff");
    
    response.body.pipe(res);
  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(500).send("Proxy error");
  }
});

// ==================== HEALTH CHECK ====================
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    online: users.size,
    totalUsers: Object.keys(userSessions).length,
    videoCalls: videoCallUsers.size / 2,
    waiting: waitingUsers.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    nodeVersion: process.version
  });
});

// ==================== START SERVER WITH PORT FALLBACK ====================
const DEFAULT_PORT = 3000;
const MAX_PORT_ATTEMPTS = 10;

function startServer(attemptPort) {
  server.listen(attemptPort)
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const nextPort = attemptPort + 1;
        if (nextPort <= DEFAULT_PORT + MAX_PORT_ATTEMPTS) {
          console.log(`⚠️ Port ${attemptPort} is in use, trying port ${nextPort}...`);
          startServer(nextPort);
        } else {
          console.error(`❌ Could not find available port after ${MAX_PORT_ATTEMPTS} attempts`);
          process.exit(1);
        }
      } else {
        console.error('❌ Server error:', err);
        process.exit(1);
      }
    })
    .on('listening', () => {
      const address = server.address();
      console.log(`\n🚀 Skideey server running successfully!`);
      console.log(`📱 Main app: http://localhost:${address.port}`);
      console.log(`🔧 Admin: http://localhost:${address.port}/admin.html`);
      console.log(`💾 User data saved to: ${DATA_FILE}`);
      console.log(`📊 Total saved users: ${Object.keys(userSessions).length}`);
      console.log(`🎥 Video calls supported with WebRTC`);
      console.log(`✅ Skip and Report buttons working`);
      console.log(`📱 Mobile-optimized UI with no duplicate messages`);
      console.log(`\n⚡ Press Ctrl+C to stop the server\n`);
    });
}

const PORT = process.env.PORT || DEFAULT_PORT;
console.log(`🔍 Attempting to start server on port ${PORT}...`);
startServer(parseInt(PORT));