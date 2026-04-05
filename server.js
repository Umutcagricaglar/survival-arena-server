// ============================================================
// server.js  –  Survival Arena multiplayer server.
// ============================================================

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const PORT = process.env.PORT || 3000;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, '..')));

// ============================================================
//  In-memory rooms
// ============================================================

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
//  Constants — mirror client CONFIG
// ============================================================

const WORLD_W = 3200;
const WORLD_H = 2400;

const ENEMY_TYPES = {
  basic: { radius: 14, speed: 80,  hp: 40,   damage: 10, exp: 10,  color: '#e57373' },
  fast:  { radius: 10, speed: 145, hp: 20,   damage: 8,  exp: 12,  color: '#ff8a65' },
  tank:  { radius: 23, speed: 45,  hp: 130,  damage: 20, exp: 28,  color: '#7e57c2' },
  boss:  { radius: 38, speed: 32,  hp: 800,  damage: 35, exp: 120, color: '#f06292' },
  ninja: { radius: 9,  speed: 310, hp: 18,   damage: 60, exp: 20,  color: '#263238' },
};

const WAVE_CFG = {
  duration:         30,
  spawnInterval:    1.1,
  minSpawnInterval: 0.12,
  spawnDecrease:    0.09,
  hpScale:          0.18,
  speedScale:       0.06,
};

// ============================================================
//  Server-side Game State
// ============================================================

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

    // Pending exp orbs (id → {id,x,y,value}) — collected by players
    this.serverOrbs  = new Map();
    this.nextOrbId   = 1;

    // Upgrade-pause: count of players currently on upgrade screen
    this.playersUpgrading = 0;

    // Boss wave tracking
    this._bossSpawnedThisWave = false;

    // Boss ability state
    this._bossFreezeTimer  = 0;
    this._bossChargeTimer  = 0;
    this._bossAbilityPhase = 'none'; // 'none' | 'freeze' | 'charge'

    this._interval = null;
  }

  start() {
    this._interval = setInterval(() => this._tick(1 / 20), 1000 / 20);
  }

  stop() {
    clearInterval(this._interval);
    this._interval = null;
  }

  // ============================================================
  //  Main tick (20 Hz)
  // ============================================================

  _tick(dt) {
    // Pause ALL simulation while any player is on the upgrade screen
    if (this.playersUpgrading > 0) {
      this._broadcastState(); // send frozen state so clients don't drift
      return;
    }

    // ---- Wave timer
    this.waveTimer += dt;
    if (this.waveTimer >= WAVE_CFG.duration) {
      this.waveTimer = 0;
      this.wave++;
      this._bossSpawnedThisWave = false;
      this.spawnInterval = Math.max(
        WAVE_CFG.minSpawnInterval,
        WAVE_CFG.spawnInterval - (this.wave - 1) * WAVE_CFG.spawnDecrease,
      );
      this._broadcastWaveChange();
    }

    // ---- Enemy spawning (paused while any player is upgrading)
    if (this.playersUpgrading === 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = this.spawnInterval;
        this._spawnEnemy();
        // Extra spawns scale with wave
        if (this.wave >= 3) {
          const extraChance = Math.min(0.85, 0.35 + (this.wave - 3) * 0.05);
          if (Math.random() < extraChance) this._spawnEnemy();
          if (this.wave >= 8  && Math.random() < 0.50) this._spawnEnemy();
          if (this.wave >= 15 && Math.random() < 0.40) this._spawnEnemy();
        }
      }
    }

    // ---- Boss ability state machine
    this._tickBossAbility(dt);

    // ---- Move enemies
    const playerList = [...this.room.players.values()].filter(p => p.hp > 0);
    if (playerList.length > 0) {
      for (const e of this.enemies) {
        if (e.bossFrozen) {
          e.vx = 0; e.vy = 0;
          continue;
        }
        const spd = e.charging ? e.baseSpeed * 2.5 : e.baseSpeed;

        let targetX = playerList[0].x, targetY = playerList[0].y;
        let bestDist = Infinity;
        for (const p of playerList) {
          const d = Math.sqrt((p.x - e.x) ** 2 + (p.y - e.y) ** 2);
          if (d < bestDist) { bestDist = d; targetX = p.x; targetY = p.y; }
        }
        const dx   = targetX - e.x, dy = targetY - e.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 1) {
          e.vx = (dx / dist) * spd;
          e.vy = (dy / dist) * spd;
          e.x += e.vx * dt;
          e.y += e.vy * dt;
        } else {
          e.vx = 0; e.vy = 0;
        }
      }
    }

    // ---- Remove dead enemies
    this.enemies = this.enemies.filter(e => e.hp > 0);

    // ---- Broadcast
    this._broadcastState();
  }

  // ============================================================
  //  Boss ability (freeze → charge cycle)
  // ============================================================

  _tickBossAbility(dt) {
    const boss = this.enemies.find(e => e.type === 'boss' && e.hp > 0);
    if (!boss) {
      // Boss gone — clear any lingering freeze/charge
      if (this._bossAbilityPhase !== 'none') {
        this._bossAbilityPhase = 'none';
        for (const e of this.enemies) { e.bossFrozen = false; e.charging = false; }
        io.to(this.room.code).emit('bossAbility', { phase: 'none' });
      }
      return;
    }

    boss.abilityCooldown = (boss.abilityCooldown || 0) - dt;

    if (this._bossAbilityPhase === 'none' && boss.abilityCooldown <= 0) {
      // Start freeze
      const freezeDur = 2 + Math.random();
      this._bossAbilityPhase = 'freeze';
      this._bossFreezeTimer  = freezeDur;
      boss.abilityCooldown   = 9999;

      for (const e of this.enemies) {
        if (e !== boss) e.bossFrozen = true;
      }

      // Spawn 3–5 minions in a ring around boss
      const count = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        const a  = (i / count) * Math.PI * 2;
        const sx = boss.x + Math.cos(a) * (boss.radius + 55);
        const sy = boss.y + Math.sin(a) * (boss.radius + 55);
        this._spawnEnemyAt('basic', sx, sy, this.wave, true /* frozenOnSpawn */);
      }

      io.to(this.room.code).emit('bossAbility', { phase: 'freeze', duration: freezeDur });

    } else if (this._bossAbilityPhase === 'freeze') {
      this._bossFreezeTimer -= dt;
      if (this._bossFreezeTimer <= 0) {
        // Transition to charge
        this._bossAbilityPhase = 'charge';
        this._bossChargeTimer  = 2.0;
        for (const e of this.enemies) {
          if (e !== boss) { e.bossFrozen = false; e.charging = true; }
        }
        io.to(this.room.code).emit('bossAbility', { phase: 'charge', duration: 2.0 });
      }

    } else if (this._bossAbilityPhase === 'charge') {
      this._bossChargeTimer -= dt;
      if (this._bossChargeTimer <= 0) {
        this._bossAbilityPhase = 'none';
        boss.abilityCooldown   = 15;
        for (const e of this.enemies) { e.charging = false; }
        io.to(this.room.code).emit('bossAbility', { phase: 'none' });
      }
    }
  }

  // ============================================================
  //  Spawning
  // ============================================================

  _spawnEnemy() {
    const isBossWave = (this.wave === 10 || this.wave === 15 || this.wave === 20);
    if (isBossWave && !this._bossSpawnedThisWave) {
      const bossAlive = this.enemies.some(e => e.type === 'boss');
      if (!bossAlive) {
        this._bossSpawnedThisWave = true;
        const m    = 70;
        const side = Math.floor(Math.random() * 4);
        let x, y;
        switch (side) {
          case 0: x = Math.random() * WORLD_W; y = -m; break;
          case 1: x = WORLD_W + m; y = Math.random() * WORLD_H; break;
          case 2: x = Math.random() * WORLD_W; y = WORLD_H + m; break;
          default: x = -m; y = Math.random() * WORLD_H; break;
        }
        this._spawnEnemyAt('boss', x, y, this.wave);
        return;
      }
    }

    // Ninja: wave 15+, capped 10% chance
    if (this.wave >= 15 && Math.random() < Math.min(0.10, 0.04 + (this.wave - 15) * 0.003)) {
      const m    = 70;
      const side = Math.floor(Math.random() * 4);
      let x, y;
      switch (side) {
        case 0: x = Math.random() * WORLD_W; y = -m; break;
        case 1: x = WORLD_W + m; y = Math.random() * WORLD_H; break;
        case 2: x = Math.random() * WORLD_W; y = WORLD_H + m; break;
        default: x = -m; y = Math.random() * WORLD_H; break;
      }
      this._spawnEnemyAt('ninja', x, y, this.wave);
      return;
    }

    const r = Math.random();
    let type;
    if (this.wave <= 2)      type = 'basic';
    else if (this.wave <= 4) type = r < 0.3  ? 'fast'  : 'basic';
    else if (this.wave <= 7) type = r < 0.4  ? 'basic' : r < 0.72 ? 'fast' : 'tank';
    else                     type = r < 0.35 ? 'basic' : r < 0.65 ? 'fast' : 'tank';

    const m    = 70;
    const side = Math.floor(Math.random() * 4);
    let x, y;
    switch (side) {
      case 0: x = Math.random() * WORLD_W; y = -m; break;
      case 1: x = WORLD_W + m; y = Math.random() * WORLD_H; break;
      case 2: x = Math.random() * WORLD_W; y = WORLD_H + m; break;
      default: x = -m; y = Math.random() * WORLD_H; break;
    }
    this._spawnEnemyAt(type, x, y, this.wave);
  }

  _spawnEnemyAt(type, x, y, waveMult, frozenOnSpawn = false) {
    const tpl  = ENEMY_TYPES[type];
    const wMul = Math.max(1, waveMult);
    const hp   = Math.round(tpl.hp * (1 + (wMul - 1) * WAVE_CFG.hpScale));
    const spd  = tpl.speed * (1 + (wMul - 1) * WAVE_CFG.speedScale);

    const enemy = {
      id:         this.nextEnemyId++,
      type, x, y,
      hp, maxHp: hp,
      baseSpeed:  spd, speed: spd,
      damage:     tpl.damage,
      exp:        tpl.exp,
      radius:     tpl.radius,
      color:      tpl.color,
      vx: 0, vy: 0,
      bossFrozen: frozenOnSpawn || (this._bossAbilityPhase === 'freeze' && type !== 'boss'),
      charging:   false,
      waveMult:   wMul,
      // Boss ability cooldown
      abilityCooldown: type === 'boss' ? 10 : 0,
    };
    this.enemies.push(enemy);
    io.to(this.room.code).emit('enemySpawned', {
      id:       enemy.id, type, x, y,
      hp, maxHp: hp, speed: spd, waveMult: wMul,
      damage:   tpl.damage, exp: tpl.exp,
      radius:   tpl.radius, color: tpl.color,
    });
    return enemy;
  }

  // ============================================================
  //  Damage / Death
  // ============================================================

  damageEnemy(id, amount) {
    // Guard: only damage enemies still alive (prevents double-death from duplicate reports)
    const e = this.enemies.find(e => e.id === id && e.hp > 0);
    if (!e) return;
    e.hp -= amount;
    if (e.hp <= 0) {
      e.hp = 0;
      this._onEnemyDeath(e);
    }
  }

  _onEnemyDeath(e) {
    // Spawn a server-tracked orb; exp is only granted when a client collects it
    const orbId = this.nextOrbId++;
    this.serverOrbs.set(orbId, { id: orbId, x: e.x, y: e.y, value: e.exp });
    io.to(this.room.code).emit('enemyDied', { id: e.id, exp: e.exp, orbId, x: e.x, y: e.y });
  }

  // Called when a client reports collecting an orb
  _grantExp(value, orbId) {
    this.sharedExp += value;
    let gained = 0;
    while (this.sharedExp >= this.sharedExpNext) {
      this.sharedExp    -= this.sharedExpNext;
      this.sharedExpNext = Math.floor(this.sharedExpNext * 1.3);
      this.sharedLevel++;
      gained++;
    }
    if (gained > 0) {
      this.playersUpgrading = this.room.players.size;
      io.to(this.room.code).emit('levelUp', {
        level:   this.sharedLevel,
        gained,
        expLeft: this.sharedExp,
        expNext: this.sharedExpNext,
      });
    }
    // Confirm collection to all clients with current exp state
    io.to(this.room.code).emit('orbCollected', {
      id:      orbId,
      exp:     this.sharedExp,
      expNext: this.sharedExpNext,
      level:   this.sharedLevel,
    });
  }

  // ============================================================
  //  Broadcasts
  // ============================================================

  _broadcastState() {
    io.to(this.room.code).emit('gameStateSync', {
      enemies: this.enemies.map(e => ({
        id:         e.id,
        x:          e.x,  y: e.y,
        hp:         e.hp,
        vx:         e.vx || 0, vy: e.vy || 0,
        bossFrozen: e.bossFrozen || false,
        charging:   e.charging  || false,
      })),
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
    if (getRoomBySocket(socket.id)) return;
    const code = createRoom(socket);
    socket.join(code);
    socket.emit('roomCreated', { code, players: [...rooms.get(code).players.values()] });
    console.log(`[Room] ${socket.id} created room ${code}`);
  });

  socket.on('joinRoom', code => {
    const room = rooms.get(code);
    if (!room) { socket.emit('roomError', { message: `Room "${code}" not found.` }); return; }
    if (room.players.size >= 2) { socket.emit('roomError', { message: 'Room is full.' }); return; }
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

    const all = [...room.players.values()];
    if (all.length >= 2 && all.every(p => p.ready)) {
      room.game = new ServerGameState(room);
      room.game.start();
      io.to(room.code).emit('gameStart', {
        players: all,
        worldW:  WORLD_W,
        worldH:  WORLD_H,
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

  // Relay fired bullets to the other player
  socket.on('bulletFired', data => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    socket.to(room.code).emit('bulletFired', { id: socket.id, ...data });
  });

  // Relay fired lasers to the other player
  socket.on('laserFired', data => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    socket.to(room.code).emit('laserFired', { id: socket.id, ...data });
  });

  socket.on('enemyDamaged', data => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.game) return;
    room.game.damageEnemy(data.id, data.damage);
  });

  // Client collected an exp orb — grant exp once (dedup by orb ID)
  socket.on('orbCollected', data => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.game) return;
    const g   = room.game;
    const orb = g.serverOrbs.get(data.id);
    if (!orb) return; // already collected or stale
    g.serverOrbs.delete(data.id);
    g._grantExp(orb.value, orb.id);
  });

  // Upgrade sync
  socket.on('upgradeScreenOpen', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.game) return;
    room.game.playersUpgrading = Math.min(
      room.players.size,
      (room.game.playersUpgrading || 0) + 1,
    );
  });

  socket.on('upgradePicked', data => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.game) return;

    if (!room.game.pendingUpgrades) room.game.pendingUpgrades = new Map();
    room.game.pendingUpgrades.set(socket.id, data);

    // Decrement upgrading count for this player
    room.game.playersUpgrading = Math.max(0, (room.game.playersUpgrading || 1) - 1);

    const playerCount = room.players.size;
    if (room.game.pendingUpgrades.size >= playerCount) {
      const choices = {};
      for (const [id, d] of room.game.pendingUpgrades) choices[id] = d;
      io.to(room.code).emit('upgradesDone', choices);
      room.game.pendingUpgrades.clear();
    } else {
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
      io.to(room.code).emit('partnerDisconnected', { id: socket.id });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🎮  Survival Arena Server running on http://localhost:${PORT}`);
  console.log(`    Open http://localhost:${PORT} in your browser to play.\n`);
});


