require('dotenv').config();
const express = require("express");
const http = require("http");
const https = require("https");
const { Server } = require("socket.io");
const fs = require('fs').promises;
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// ==================== SECURITY MIDDLEWARE ====================
// Helmet for security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https:", "http:"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:", "http:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:", "http:"],
      mediaSrc: ["'self'", "data:", "https:", "http:"],
      frameSrc: ["'self'", "https:", "http:"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS configuration
app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Logging
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Compression
app.use(compression());

// Body parsing with limits
app.use(express.static("public"));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==================== CONFIGURATION ====================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-in-production";
const PORT = parseInt(process.env.PORT || '3000');
const NODE_ENV = process.env.NODE_ENV || 'development';

console.log(`🚀 Starting Skideey in ${NODE_ENV} mode`);

// ==================== SOCKET.IO ====================
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || '*',
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8 // 100MB for media files
});

// ==================== FILE-BASED PERSISTENCE ====================
const DATA_FILE = path.join(__dirname, 'data', 'users.json');
const POSTS_FILE = path.join(__dirname, 'data', 'posts.json');

async function ensureDataDir() {
  const dataDir = path.join(__dirname, 'data');
  try {
    await fs.access(dataDir);
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
  }
}
ensureDataDir();

async function loadUsers() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

async function saveUsers(users) {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(users, null, 2));
    console.log('💾 Users saved to disk');
  } catch (err) {
    console.error('❌ Failed to save users:', err.message);
  }
}

async function loadPosts() {
  try {
    const data = await fs.readFile(POSTS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

async function savePosts(posts) {
  try {
    await fs.writeFile(POSTS_FILE, JSON.stringify(posts, null, 2));
    console.log('💾 Posts saved to disk');
  } catch (err) {
    console.error('❌ Failed to save posts:', err.message);
  }
}

// ==================== DATA STRUCTURES ====================
let userSessions = {};
let users = new Map();
let waitingUsers = new Set();
let videoCallUsers = new Map();
const messageQueue = [];
let onlineCount = 0;
let globalPosts = [];

// Monitoring
let emojiCount = {};
let countryCount = {};

// Load saved data on startup
(async () => {
  userSessions = await loadUsers();
  globalPosts = await loadPosts();
  console.log(`📂 Loaded ${Object.keys(userSessions).length} saved users`);
  console.log(`📂 Loaded ${globalPosts.length} saved posts`);
})();

// Auto-save every 5 minutes
setInterval(async () => {
  await saveUsers(userSessions);
  await savePosts(globalPosts);
}, 300000);

// Save on shutdown
process.on('SIGINT', async () => {
  console.log('\n💾 Saving data before shutdown...');
  await saveUsers(userSessions);
  await savePosts(globalPosts);
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n💾 Saving data before shutdown...');
  await saveUsers(userSessions);
  await savePosts(globalPosts);
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
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.ekiga.net' },
    { urls: 'stun:stun.ideasip.com' },
    { urls: 'stun:stun.iptel.org' },
    { urls: 'stun:stun.rixtelecom.se' },
    { urls: 'stun:stun.schlund.de' }
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
      lastSeen: Date.now(),
      bio: '',
      interests: [],
      avatar: '',
      status: 'online'
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
  
  // Send online users list
  const onlineUsersList = {};
  for (const [id, u] of users) {
    onlineUsersList[id] = {
      username: u.username,
      avatar: u.avatar || '',
      bio: u.bio || '',
      interests: u.interests || [],
      status: u.status || 'online'
    };
  }
  socket.emit("onlineUsers", onlineUsersList);
  
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

  // ==================== PROFILE UPDATE ====================
  socket.on("profileUpdate", (data) => {
    if (data.username) user.username = data.username;
    if (data.avatar) user.avatar = data.avatar;
    if (data.bio !== undefined) user.bio = data.bio;
    if (data.interests) user.interests = data.interests;
    if (data.status) user.status = data.status;
    
    if (user.deviceId) {
      userSessions[user.deviceId] = user;
      saveUsers(userSessions);
    }
    
    // Broadcast profile update to all users
    io.emit("userProfileUpdate", {
      id: socket.id,
      username: user.username,
      avatar: user.avatar,
      bio: user.bio,
      interests: user.interests,
      status: user.status
    });
    
    // Update online users list
    const onlineUsersList = {};
    for (const [id, u] of users) {
      onlineUsersList[id] = {
        username: u.username,
        avatar: u.avatar || '',
        bio: u.bio || '',
        interests: u.interests || [],
        status: u.status || 'online'
      };
    }
    io.emit("onlineUsers", onlineUsersList);
  });

  // ==================== STATUS UPDATE ====================
  socket.on("statusUpdate", (status) => {
    user.status = status;
    if (user.deviceId) {
      userSessions[user.deviceId] = user;
      saveUsers(userSessions);
    }
    io.emit("userStatusUpdate", {
      id: socket.id,
      status: status,
      username: user.username
    });
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
      io.emit("userProfileUpdate", {
        id: socket.id,
        username: newUsername,
        avatar: user.avatar
      });
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

  // ==================== TYPING INDICATOR ====================
  socket.on("typing", () => {
    if (socket.partner) {
      io.to(socket.partner).emit("typing", { senderId: socket.id });
    }
  });

  socket.on("stopTyping", () => {
    if (socket.partner) {
      io.to(socket.partner).emit("stopTyping");
    }
  });

  // ==================== MESSAGE READ ====================
  socket.on("messageRead", (data) => {
    if (socket.partner) {
      io.to(socket.partner).emit("messageRead", data);
    }
  });

  // ==================== PUBLIC GIF ====================
  socket.on("publicGif", (data) => {
    if (!data.url || !data.url.startsWith("http")) return;
    
    io.emit("publicMessage", {
      name: user.username,
      message: `<img src="${data.url}" style="max-width:200px; border-radius:10px;" loading="lazy">`,
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
        message: `<img src="${data.url}" style="max-width:200px; border-radius:10px;" loading="lazy">`,
        senderUuid: socket.id,
        timestamp: Date.now()
      });
    }
    
    socket.emit("randomMessage", {
      name: user.username,
      message: `<img src="${data.url}" style="max-width:200px; border-radius:10px;" loading="lazy">`,
      senderUuid: socket.id,
      timestamp: Date.now()
    });
  });

  // ==================== POST SYSTEM ====================
  socket.on("sharePost", (postData) => {
    // Store post globally
    const existingIndex = globalPosts.findIndex(p => p.id === postData.id);
    if (existingIndex === -1) {
      globalPosts.push(postData);
    } else {
      globalPosts[existingIndex] = postData;
    }
    savePosts(globalPosts);
    
    // Broadcast to all connected users
    io.emit("sharePost", postData);
    console.log(`📝 Post shared by ${postData.author}: ${postData.caption?.substring(0, 30)}...`);
  });

  socket.on("postReceived", (postData) => {
    // Broadcast to all connected users
    io.emit("postReceived", postData);
  });

  socket.on("requestPosts", () => {
    // Send all posts to the requesting user
    globalPosts.forEach(post => {
      socket.emit("sharePost", post);
    });
    console.log(`📤 Sent ${globalPosts.length} posts to ${user.username}`);
  });

  socket.on("deletePost", (data) => {
    globalPosts = globalPosts.filter(p => p.id !== data.id);
    savePosts(globalPosts);
    io.emit("deletePost", data);
    console.log(`🗑️ Post deleted: ${data.id}`);
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
          saveUsers(userSessions);
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

  // ==================== BLOCK USER ====================
  socket.on("blockUser", (username) => {
    console.log(`🚫 ${user.username} blocked ${username}`);
    io.emit("userBlocked", {
      blocker: user.username,
      blocked: username
    });
  });

  socket.on("unblockUser", (username) => {
    console.log(`🔓 ${user.username} unblocked ${username}`);
    io.emit("userUnblocked", {
      blocker: user.username,
      blocked: username
    });
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
    console.log(`📝 Reason: ${data.reason || 'Inappropriate behavior'}`);
    
    socket.emit("reportSubmitted", {
      message: "Report submitted. Thank you for keeping Skideey safe!"
    });
    
    io.to("admin").emit("userReported", {
      reporter: user.username,
      reported: reportedUser?.username,
      reason: data.reason || "Inappropriate behavior",
      timestamp: new Date().toISOString()
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
    
    // Update online users list
    const onlineUsersList = {};
    for (const [id, u] of users) {
      onlineUsersList[id] = {
        username: u.username,
        avatar: u.avatar || '',
        bio: u.bio || '',
        interests: u.interests || [],
        status: u.status || 'online'
      };
    }
    io.emit("onlineUsers", onlineUsersList);
    
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
  const totalPosts = globalPosts.length;
  
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
  
  const postsByType = {
    post: globalPosts.filter(p => p.type === 'post' || !p.type).length,
    poll: globalPosts.filter(p => p.type === 'poll').length,
    event: globalPosts.filter(p => p.type === 'event').length
  };
  
  io.to("admin").emit("adminStats", {
    online,
    totalUsers,
    totalPosts,
    postsByType,
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
    totalPosts: globalPosts.length,
    videoCalls: videoCallUsers.size / 2,
    waiting: waitingUsers.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    nodeVersion: process.version,
    environment: NODE_ENV
  });
});

// ==================== 404 HANDLER ====================
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ==================== ERROR HANDLER ====================
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err.stack);
  res.status(500).json({ 
    error: 'Something went wrong!',
    message: NODE_ENV === 'development' ? err.message : 'Internal server error'
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
      console.log(`📝 Posts data saved to: ${POSTS_FILE}`);
      console.log(`📊 Total saved users: ${Object.keys(userSessions).length}`);
      console.log(`📊 Total saved posts: ${globalPosts.length}`);
      console.log(`🎥 Video calls supported with WebRTC`);
      console.log(`✅ All social features enabled`);
      console.log(`📱 Mobile-optimized UI with floating create button`);
      console.log(`🔒 Security: Helmet, CORS, Rate limiting enabled`);
      console.log(`📝 Logging: ${NODE_ENV === 'production' ? 'combined' : 'dev'} mode`);
      console.log(`\n⚡ Press Ctrl+C to stop the server\n`);
    });
}

console.log(`🔍 Attempting to start server on port ${PORT}...`);
startServer(parseInt(PORT));