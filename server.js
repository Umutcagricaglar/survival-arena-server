// ============================================================
// server.js  –  Survival Arena multiplayer server.
//
// Setup:
//   cd server
//   npm install
//   npm start        (runs on port 3000 by default)
//
// Architecture:
//   • Server is authoritative for: enemy spawning, enemy
//     movement, wave state, shared EXP/level.
//   • Clients are authoritative for: own player position/HP,
//     own bullets (server only broadcasts fired positions).
//   • Game state is broadcast at 20 Hz.
// ============================================================

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');

const PORT = process.env.PORT || 3000;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Serve the game from the parent folder
app.use(express.static(path.join(__dirname, '..')));

// ============================================================
//  In-memory rooms
// ============================================================

// rooms[code] = { players: Map<socketId, PlayerState>, game: GameState | null }
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(hostSocket) {
  let code;
  do { code = generateCode(); } while (rooms.has(code));

  rooms.set(code, {
    code,
    players: new Map([[hostSocket.id, {
      id: hostSocket.id, name: 'Player 1', ready: false, host: true,
      x: 0, y: 0, hp: 100, level: 1,
    }]]),
    game: null,
  });
  return code;
}

function getRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) return room;
  }
  return null;
}

// ============================================================
//  Game State (server-side simulation)
// ============================================================

// Wave / enemy config mirrors client CONFIG
const ENEMY_TYPES = {
  basic: { radius: 14, speed: 80,  hp: 40,  damage: 10, exp: 10, color: '#e57373' },
  fast:  { radius: 10, speed: 145, hp: 20,  damage: 8,  exp: 12, color: '#ff8a65' },
  tank:  { radius: 23, speed: 45,  hp: 130, damage: 20, exp: 28, color: '#7e57c2' },
};

const WAVE_CFG = {
  duration:         30,
  spawnInterval:    2.0,
  minSpawnInterval: 0.28,
  spawnDecrease:    0.15,
  hpScale:          0.18,
  speedScale:       0.06,
};

class ServerGameState {
  constructor(room) {
    this.room          = room;
    this.enemies       = [];
    this.nextEnemyId   = 1;
    this.wave          = 1;
    this.waveTimer     = 0;
    this.spawnTimer    = 0;
    this.spawnInterval = WAVE_CFG.spawnInterval;
    this.sharedExp     = 0;
    this.sharedLevel   = 1;
    this.sharedExpNext = 20;
    this.canvasW       = 1280;
    this.canvasH       = 720;
    this._interval     = null;
  }

  start() {
    this._interval = setInterval(() => this._tick(1 / 20), 1000 / 20);
  }

  stop() {
    clearInterval(this._interval);
    this._interval = null;
  }

  _tick(dt) {
    // Wave timer
    this.waveTimer += dt;
    if (this.waveTimer >= WAVE_CFG.duration) {
      this.waveTimer = 0;
      this.wave++;
      this.spawnInterval = Math.max(
        WAVE_CFG.minSpawnInterval,
        WAVE_CFG.spawnInterval - (this.wave - 1) * WAVE_CFG.spawnDecrease,
      );
      this._broadcastWaveChange();
    }

    // Enemy spawning
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = this.spawnInterval;
      this._spawnEnemy();
    }

    // Move enemies toward closest player
    const playerList = [...this.room.players.values()].filter(p => p.hp > 0);
    if (playerList.length > 0) {
      for (const e of this.enemies) {
        // Find closest player
        let targetX = playerList[0].x, targetY = playerList[0].y;
        let bestDist = Infinity;
        for (const p of playerList) {
          const d = Math.sqrt((p.x - e.x) ** 2 + (p.y - e.y) ** 2);
          if (d < bestDist) { bestDist = d; targetX = p.x; targetY = p.y; }
        }
        const dx   = targetX - e.x, dy = targetY - e.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 1) {
          e.vx = (dx / dist) * e.speed;
          e.vy = (dy / dist) * e.speed;
          e.x += e.vx * dt;
          e.y += e.vy * dt;
        } else {
          e.vx = 0; e.vy = 0;
        }
      }
    }

    // Remove dead enemies that have had their death processed
    this.enemies = this.enemies.filter(e => e.hp > 0);

    // Broadcast state at 20 Hz
    this._broadcastState();
  }

  _spawnEnemy() {
    const m    = 70;
    const side = Math.floor(Math.random() * 4);
    let x, y;
    switch (side) {
      case 0: x = Math.random() * this.canvasW; y = -m; break;
      case 1: x = this.canvasW + m; y = Math.random() * this.canvasH; break;
      case 2: x = Math.random() * this.canvasW; y = this.canvasH + m; break;
      default: x = -m; y = Math.random() * this.canvasH; break;
    }
    const types = this.wave <= 2 ? ['basic'] :
                  this.wave <= 4 ? ['basic','basic','fast'] :
                  ['basic','fast','tank'];
    const type = types[Math.floor(Math.random() * types.length)];
    const tpl  = ENEMY_TYPES[type];
    const wMul = this.wave;
    const hp   = Math.round(tpl.hp * (1 + (wMul - 1) * WAVE_CFG.hpScale));
    const spd  = tpl.speed * (1 + (wMul - 1) * WAVE_CFG.speedScale);

    const enemy = {
      id: this.nextEnemyId++,
      type, x, y,
      hp, maxHp: hp, speed: spd,
      damage: tpl.damage, exp: tpl.exp,
      radius: tpl.radius, color: tpl.color,
      vx: 0, vy: 0,
    };
    this.enemies.push(enemy);

    io.to(this.room.code).emit('enemySpawned', enemy);
  }

  damageEnemy(id, amount) {
    const e = this.enemies.find(e => e.id === id);
    if (!e) return;
    e.hp -= amount;
    if (e.hp <= 0) {
      e.hp = 0;
      this._onEnemyDeath(e);
    }
  }

  _onEnemyDeath(e) {
    this.sharedExp += e.exp;
    let gained = 0;
    while (this.sharedExp >= this.sharedExpNext) {
      this.sharedExp -= this.sharedExpNext;
      this.sharedExpNext = Math.floor(this.sharedExpNext * 1.4);
      this.sharedLevel++;
      gained++;
    }
    if (gained > 0) {
      io.to(this.room.code).emit('levelUp', {
        level:   this.sharedLevel,
        gained,
        expLeft: this.sharedExp,
        expNext: this.sharedExpNext,
      });
    }
    io.to(this.room.code).emit('enemyDied', {
      id:     e.id,
      exp:    e.exp,
      x:      e.x,
      y:      e.y,
    });
  }

  _broadcastState() {
    io.to(this.room.code).emit('gameStateSync', {
      enemies:     this.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, hp: e.hp, vx: e.vx || 0, vy: e.vy || 0 })),
      wave:        this.wave,
      sharedLevel: this.sharedLevel,
      sharedExp:   this.sharedExp,
      sharedExpNext: this.sharedExpNext,
    });
  }

  _broadcastWaveChange() {
    io.to(this.room.code).emit('waveChange', { wave: this.wave });
  }
}

// ============================================================
//  Socket events
// ============================================================

io.on('connection', socket => {
  console.log(`[+] Connected: ${socket.id}`);

  // ---- Lobby ---------------------------------------------------

  socket.on('setColor', data => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) player.color = data.color;
    socket.to(room.code).emit('playerColorChanged', { id: socket.id, color: data.color });
  });

  socket.on('createRoom', () => {
    const room = getRoomBySocket(socket.id);
    if (room) return;  // already in a room

    const code = createRoom(socket);
    socket.join(code);
    socket.emit('roomCreated', { code, players: [...rooms.get(code).players.values()] });
    console.log(`[Room] ${socket.id} created room ${code}`);
  });

  socket.on('joinRoom', code => {
    const room = rooms.get(code);
    if (!room) {
      socket.emit('roomError', { message: `Room "${code}" not found.` });
      return;
    }
    if (room.players.size >= 2) {
      socket.emit('roomError', { message: 'Room is full.' });
      return;
    }
    const playerNum = room.players.size + 1;
    room.players.set(socket.id, {
      id: socket.id, name: `Player ${playerNum}`, ready: false, host: false,
      x: 0, y: 0, hp: 100, level: 1,
    });
    socket.join(code);
    socket.emit('roomJoined', { code, players: [...room.players.values()] });
    socket.to(code).emit('playerJoined', room.players.get(socket.id));
    console.log(`[Room] ${socket.id} joined room ${code}`);
  });

  socket.on('playerReady', () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) player.ready = true;

    io.to(room.code).emit('playerReady', { id: socket.id });

    // Start when all players ready (min 2)
    const all = [...room.players.values()];
    if (all.length >= 2 && all.every(p => p.ready)) {
      room.game = new ServerGameState(room);
      room.game.start();
      io.to(room.code).emit('gameStart', {
        players: all,
        canvasW: room.game.canvasW,
        canvasH: room.game.canvasH,
      });
      console.log(`[Game] Room ${room.code} started`);
    }
  });

  // ---- In-game -------------------------------------------------

  socket.on('playerUpdate', data => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p) { p.x = data.x; p.y = data.y; p.hp = data.hp; }
    socket.to(room.code).emit('playerUpdate', { id: socket.id, ...data });
  });

  socket.on('bulletFired', data => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    socket.to(room.code).emit('bulletFired', { id: socket.id, ...data });
  });

  socket.on('enemyDamaged', data => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.game) return;
    room.game.damageEnemy(data.id, data.damage);
  });

  // ---- Upgrade sync -------------------------------------------
  // Client sends { upgradeId } when the player picks an upgrade.
  // Server waits for all players to pick, then broadcasts 'upgradesDone'.
  socket.on('upgradePicked', data => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.game) return;

    if (!room.game.pendingUpgrades) room.game.pendingUpgrades = new Map();
    room.game.pendingUpgrades.set(socket.id, data);

    const playerCount = room.players.size;
    if (room.game.pendingUpgrades.size >= playerCount) {
      // All players have chosen — broadcast and clear
      const choices = {};
      for (const [id, d] of room.game.pendingUpgrades) choices[id] = d;
      io.to(room.code).emit('upgradesDone', choices);
      room.game.pendingUpgrades.clear();
    } else {
      // Notify others that this player is waiting
      socket.to(room.code).emit('upgradeWaiting', { id: socket.id });
    }
  });

  // ---- Disconnect ----------------------------------------------

  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    const room = getRoomBySocket(socket.id);
    if (!room) return;

    room.players.delete(socket.id);
    socket.to(room.code).emit('playerLeft', { id: socket.id });

    if (room.players.size === 0) {
      if (room.game) room.game.stop();
      rooms.delete(room.code);
      console.log(`[Room] ${room.code} closed (empty)`);
    } else if (room.game) {
      // Pause for solo player
      io.to(room.code).emit('partnerDisconnected', { id: socket.id });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🎮  Survival Arena Server running on http://localhost:${PORT}`);
  console.log(`    Open http://localhost:${PORT} in your browser to play.\n`);
});
