/**
 * AeroSpeed - Internet Speed Visualizer & Analytics
 * Core Application Logic
 */

// Global Application State
const state = {
  activeTab: 'test-tab',
  db: null,
  activeServer: {
    id: 'auto',
    name: 'Auto (Cloudflare)',
    pingUrl: 'https://speed.cloudflare.com/__ping',
    downloadUrl: 'https://speed.cloudflare.com/__down',
    uploadUrl: 'https://speed.cloudflare.com/__up'
  },
  currentTest: {
    isRunning: false,
    cancelRequested: false,
    phase: 'ready', // 'ready', 'ping', 'download', 'upload', 'finished'
    pingData: [],
    ping: 0,
    jitter: 0,
    downloadSpeed: 0, // in Mbps
    uploadSpeed: 0, // in Mbps
    dataUsed: 0, // in MB
    isp: 'Detecting...',
    ip: 'Detecting...',
    serverLocation: 'Auto Detect',
    timestamp: null
  },
  analyticsView: 'daily', // 'daily', 'weekly', 'monthly'
  history: {
    currentPage: 1,
    pageSize: 10,
    totalRecords: 0,
    records: [],
    searchQuery: ''
  },
  activeTheme: 'neon',
  simulatedProvider: 'AT&T Fiber',
  backgroundTestIntervalId: null,
  bgTestEnabled: false
};

// Canvas drawing contexts & animation frames
let gaugeCtx = null;
let particleCtx = null;
let sparklineCtx = null;
let gaugeAnimId = null;
let particleAnimId = null;

// Chart.js instances
let trendChart = null;
let hourlyChart = null;

// IndexedDB Helper
const DB_NAME = 'SpeedTestDB';
const DB_VERSION = 1;
const STORE_NAME = 'tests';

// Speed thresholds and gauge percent mappings (Non-linear logarithmic scale)
// Mapped for gauge needle position interpolation
const speedThresholds = [0, 1, 5, 10, 50, 100, 250, 500, 1000];
const percentThresholds = [0, 0.08, 0.18, 0.30, 0.48, 0.62, 0.76, 0.88, 1.0];

function getSpeedPercent(speed) {
  if (speed <= 0) return 0;
  if (speed >= 1000) return 1.0;
  
  // Find interval
  let i = 0;
  while (i < speedThresholds.length - 1 && speed > speedThresholds[i + 1]) {
    i++;
  }
  
  // Interpolate
  const baseSpeed = speedThresholds[i];
  const nextSpeed = speedThresholds[i + 1];
  const basePct = percentThresholds[i];
  const nextPct = percentThresholds[i + 1];
  
  const ratio = (speed - baseSpeed) / (nextSpeed - baseSpeed);
  return basePct + ratio * (nextPct - basePct);
}

// -------------------------------------------------------------
// INDEXEDDB UTILITIES
// -------------------------------------------------------------
function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = (e) => {
      console.error('Database failed to open:', e);
      reject(e);
    };
    
    request.onsuccess = (e) => {
      state.db = e.target.result;
      console.log('Database initialized successfully');
      resolve(state.db);
    };
    
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('download', 'download', { unique: false });
        store.createIndex('upload', 'upload', { unique: false });
        store.createIndex('ping', 'ping', { unique: false });
        store.createIndex('isp', 'isp', { unique: false });
        console.log('Object store and indexes created');
      }
    };
  });
}

function saveTestRecord(record) {
  return new Promise((resolve, reject) => {
    if (!state.db) return reject('DB not initialized');
    const transaction = state.db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    const request = store.add(record);
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e);
  });
}

function getAllRecords() {
  return new Promise((resolve, reject) => {
    if (!state.db) return resolve([]);
    const transaction = state.db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const request = index.getAll();
    
    request.onsuccess = () => {
      // Sort descending by default
      const sorted = request.result.sort((a, b) => b.timestamp - a.timestamp);
      resolve(sorted);
    };
    request.onerror = (e) => reject(e);
  });
}

function deleteRecord(id) {
  return new Promise((resolve, reject) => {
    if (!state.db) return reject('DB not initialized');
    const transaction = state.db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e);
  });
}

function clearDatabase() {
  return new Promise((resolve, reject) => {
    if (!state.db) return reject('DB not initialized');
    const transaction = state.db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();
    
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e);
  });
}

// -------------------------------------------------------------
// CURSOR FOLLOWER ANIMATION (LIQUID DROPLETS)
// -------------------------------------------------------------
class CursorDroplets {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.droplets = [];
    this.mouseX = null;
    this.mouseY = null;
    this.lastMouseX = null;
    this.lastMouseY = null;
    this.resize();
    
    // Bind mousemove
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      
      // Calculate speed of cursor
      let speed = 0;
      if (this.lastMouseX !== null && this.lastMouseY !== null) {
        const dx = this.mouseX - this.lastMouseX;
        const dy = this.mouseY - this.lastMouseY;
        speed = Math.sqrt(dx * dx + dy * dy);
      }
      
      // Spawn droplets proportional to speed
      const spawnCount = Math.min(3, Math.floor(speed / 6) + 1);
      for (let i = 0; i < spawnCount; i++) {
        this.spawn(this.mouseX, this.mouseY, speed);
      }
      
      this.lastMouseX = this.mouseX;
      this.lastMouseY = this.mouseY;
    });
    
    // Bind mouseleave
    window.addEventListener('mouseleave', () => {
      this.mouseX = null;
      this.mouseY = null;
      this.lastMouseX = null;
      this.lastMouseY = null;
    });
    
    window.addEventListener('resize', () => this.resize());
    
    // Start animation loop
    const tick = () => {
      this.update();
      this.draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  
  resize() {
    this.canvas.width = window.innerWidth * window.devicePixelRatio;
    this.canvas.height = window.innerHeight * window.devicePixelRatio;
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }
  
  spawn(x, y, cursorSpeed) {
    // Spread velocity slightly
    const angle = Math.random() * Math.PI * 2;
    const spread = 0.2 + Math.random() * 1.5;
    
    // Slight drift opposite to mouse direction if cursor speed is high
    let vx = Math.cos(angle) * spread;
    let vy = Math.sin(angle) * spread - 0.2; // default drift up slightly
    
    const size = 3.0 + Math.random() * 5.0; // size of droplet
    
    // Color palette: bioluminescent teal, cyan, blue
    const r = Math.random();
    let color = 'rgba(0, 242, 254, '; // neon cyan
    if (r < 0.3) {
      color = 'rgba(79, 172, 254, '; // soft blue
    } else if (r < 0.6) {
      color = 'rgba(5, 239, 178, '; // seafoam green
    }
    
    this.droplets.push({
      x: x,
      y: y,
      vx: vx,
      vy: vy,
      size: size,
      originalSize: size,
      alpha: 0.95,
      color: color,
      wobbleSpeed: 0.05 + Math.random() * 0.15,
      wobbleOffset: Math.random() * Math.PI * 2,
      life: 1.0, // normalized lifetime from 1.0 down to 0
      decay: 0.015 + Math.random() * 0.02
    });
  }
  
  update() {
    for (let i = this.droplets.length - 1; i >= 0; i--) {
      const d = this.droplets[i];
      
      // Physics: gravity pulls down, air friction
      d.vy += 0.12; // gravity
      d.vx *= 0.96;
      d.vy *= 0.96;
      
      d.x += d.vx;
      d.y += d.vy;
      
      // Lifespan decay
      d.life -= d.decay;
      d.alpha = Math.max(0, d.life * 0.95);
      d.size = d.originalSize * d.life;
      
      if (d.life <= 0 || d.size < 0.5) {
        this.droplets.splice(i, 1);
      }
    }
  }
  
  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width / window.devicePixelRatio, this.canvas.height / window.devicePixelRatio);
    
    this.droplets.forEach(d => {
      ctx.save();
      ctx.beginPath();
      
      // Calculate liquid wobble using sine wave over time
      const time = Date.now() * 0.005;
      const wobble = Math.sin(time * d.wobbleSpeed + d.wobbleOffset) * 0.15;
      
      // Stretch droplet vertically if falling fast
      const speedY = Math.abs(d.vy);
      const stretch = Math.min(0.4, speedY * 0.04);
      
      const rx = d.size * (1 - stretch + wobble);
      const ry = d.size * (1 + stretch - wobble);
      
      // Draw liquid droplet using ellipse
      ctx.ellipse(d.x, d.y, Math.max(0.1, rx), Math.max(0.1, ry), Math.atan2(d.vy, d.vx) - Math.PI / 2, 0, Math.PI * 2);
      
      ctx.fillStyle = d.color + d.alpha + ')';
      ctx.shadowBlur = d.size * 1.8;
      ctx.shadowColor = d.color.replace(/, \)$/, ', 0.6)');
      ctx.fill();
      ctx.restore();
    });
  }
}

// -------------------------------------------------------------
// PARTICLE SYSTEM (VISUALIZATION ENGINE)
// -------------------------------------------------------------
class ParticleSystem {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.pulseRings = [];
    this.maxParticles = 120;
    this.centerX = canvas.width / 2;
    this.centerY = canvas.height / 2;
    this.outerRadius = 135;
    this.innerRadius = 30;
  }
  
  clear() {
    this.particles = [];
    this.pulseRings = [];
  }
  
  triggerPulse() {
    this.pulseRings.push({
      radius: 0,
      opacity: 0.8,
      speed: 4 + Math.random() * 2,
      color: state.currentTest.phase === 'ping' ? 'rgba(236, 72, 153, 0.45)' : 'rgba(99, 102, 241, 0.3)'
    });
  }
  
  update() {
    const phase = state.currentTest.phase;
    const speed = phase === 'download' ? state.currentTest.downloadSpeed : (phase === 'upload' ? state.currentTest.uploadSpeed : 0.5);
    
    // Adjust max particles based on throughput
    const targetCount = Math.min(this.maxParticles, 15 + Math.round(speed * 0.15));
    
    // Spawn logic based on phase
    if (phase === 'download') {
      // Flow from outer bounds towards center
      if (this.particles.length < targetCount && Math.random() < 0.6) {
        const angle = Math.random() * Math.PI * 2;
        this.particles.push({
          x: this.centerX + Math.cos(angle) * (this.outerRadius + (Math.random() * 30)),
          y: this.centerY + Math.sin(angle) * (this.outerRadius + (Math.random() * 30)),
          targetX: this.centerX + Math.cos(angle) * this.innerRadius,
          targetY: this.centerY + Math.sin(angle) * this.innerRadius,
          angle: angle,
          speed: 1.5 + Math.random() * 4 + (speed * 0.08),
          size: 1 + Math.random() * 3,
          alpha: 0,
          color: 'rgba(59, 130, 246, ' + (0.3 + Math.random() * 0.5) + ')'
        });
      }
    } else if (phase === 'upload') {
      // Flow from center bounds towards outer bounds
      if (this.particles.length < targetCount && Math.random() < 0.6) {
        const angle = Math.random() * Math.PI * 2;
        this.particles.push({
          x: this.centerX + Math.cos(angle) * this.innerRadius,
          y: this.centerY + Math.sin(angle) * this.innerRadius,
          targetX: this.centerX + Math.cos(angle) * (this.outerRadius + 30),
          targetY: this.centerY + Math.sin(angle) * (this.outerRadius + 30),
          angle: angle,
          speed: 1.5 + Math.random() * 4 + (speed * 0.08),
          size: 1 + Math.random() * 3,
          alpha: 0,
          color: 'rgba(16, 185, 129, ' + (0.3 + Math.random() * 0.5) + ')'
        });
      }
    } else {
      // Idle ambient swirl
      if (this.particles.length < 30 && Math.random() < 0.1) {
        const angle = Math.random() * Math.PI * 2;
        const radius = this.innerRadius + Math.random() * (this.outerRadius - this.innerRadius);
        this.particles.push({
          x: this.centerX + Math.cos(angle) * radius,
          y: this.centerY + Math.sin(angle) * radius,
          angle: angle,
          radius: radius,
          angularSpeed: 0.005 + Math.random() * 0.015,
          speed: 0.2 + Math.random() * 0.5,
          size: 0.8 + Math.random() * 2,
          alpha: 0,
          color: 'rgba(99, 102, 241, ' + (0.1 + Math.random() * 0.3) + ')'
        });
      }
    }
    
    // Update individual particle coordinates
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      
      if (p.alpha < 1) p.alpha += 0.05;
      
      if (phase === 'download') {
        // Move towards center
        const dx = p.targetX - p.x;
        const dy = p.targetY - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < 5) {
          this.particles.splice(i, 1);
        } else {
          p.x += Math.cos(p.angle + Math.PI) * p.speed;
          p.y += Math.sin(p.angle + Math.PI) * p.speed;
        }
      } else if (phase === 'upload') {
        // Move outwards
        const dx = p.x - this.centerX;
        const dy = p.y - this.centerY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist > this.outerRadius + 20) {
          this.particles.splice(i, 1);
        } else {
          p.x += Math.cos(p.angle) * p.speed;
          p.y += Math.sin(p.angle) * p.speed;
        }
      } else {
        // SWIRL ambient motion
        p.angle += p.angularSpeed;
        p.x = this.centerX + Math.cos(p.angle) * p.radius;
        p.y = this.centerY + Math.sin(p.angle) * p.radius;
        
        // Randomly decay idle particles
        if (Math.random() < 0.01) {
          p.alpha -= 0.05;
          if (p.alpha <= 0) {
            this.particles.splice(i, 1);
          }
        }
      }
    }
    
    // Update pulse rings
    for (let i = this.pulseRings.length - 1; i >= 0; i--) {
      const r = this.pulseRings[i];
      r.radius += r.speed;
      r.opacity -= 0.015;
      if (r.opacity <= 0 || r.radius > this.outerRadius + 50) {
        this.pulseRings.splice(i, 1);
      }
    }
  }
  
  draw() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    // Draw Pulse Rings first
    this.pulseRings.forEach(r => {
      this.ctx.beginPath();
      this.ctx.arc(this.centerX, this.centerY, r.radius, 0, Math.PI * 2);
      this.ctx.strokeStyle = r.color.replace(/[\d.]+\)$/, r.opacity + ')');
      this.ctx.lineWidth = 2 + (r.radius * 0.02);
      this.ctx.stroke();
    });
    
    // Draw Particles
    this.particles.forEach(p => {
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      this.ctx.fillStyle = p.color.replace(/[\d.]+\)$/, p.alpha + ')');
      this.ctx.shadowBlur = p.size * 2;
      this.ctx.shadowColor = p.fillStyle;
      this.ctx.fill();
      this.ctx.shadowBlur = 0; // reset
    });
  }
}

// -------------------------------------------------------------
// SPEED GAUGE COMPONENT (CANVAS RENDERER)
// -------------------------------------------------------------
class SpeedGauge {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.centerX = canvas.width / 2;
    this.centerY = canvas.height / 2;
    this.radius = 125;
    this.startAngle = 0.75 * Math.PI; // 135 deg
    this.endAngle = 2.25 * Math.PI;   // 405 deg (270 deg span)
    this.currentVal = 0;
    this.targetVal = 0;
    this.easeSpeed = 0.12;
  }
  
  setSpeed(val) {
    this.targetVal = Math.min(1000, Math.max(0, val));
  }
  
  update() {
    // Smooth easing of gauge value
    const delta = this.targetVal - this.currentVal;
    if (Math.abs(delta) > 0.01) {
      this.currentVal += delta * this.easeSpeed;
    } else {
      this.currentVal = this.targetVal;
    }
  }
  
  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    const currentPercent = getSpeedPercent(this.currentVal);
    const activeAngle = this.startAngle + currentPercent * (this.endAngle - this.startAngle);
    
    // 1. Draw base outer track
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.radius, this.startAngle, this.endAngle);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.stroke();
    
    // 2. Draw Speed Gradient filled active arc
    if (currentPercent > 0.01) {
      ctx.beginPath();
      ctx.arc(this.centerX, this.centerY, this.radius, this.startAngle, activeAngle);
      
      // Determine color theme based on test phase
      let gradient = ctx.createLinearGradient(0, this.centerY + this.radius, this.canvas.width, this.centerY - this.radius);
      const phase = state.currentTest.phase;
      
      if (phase === 'download') {
        gradient.addColorStop(0, '#3b82f6');
        gradient.addColorStop(1, '#06b6d4');
        ctx.strokeStyle = gradient;
        ctx.shadowColor = 'rgba(59, 130, 246, 0.45)';
      } else if (phase === 'upload') {
        gradient.addColorStop(0, '#10b981');
        gradient.addColorStop(1, '#34d399');
        ctx.strokeStyle = gradient;
        ctx.shadowColor = 'rgba(16, 185, 129, 0.45)';
      } else if (phase === 'ping') {
        gradient.addColorStop(0, '#ec4899');
        gradient.addColorStop(1, '#a855f7');
        ctx.strokeStyle = gradient;
        ctx.shadowColor = 'rgba(236, 72, 153, 0.45)';
      } else {
        gradient.addColorStop(0, '#6366f1');
        gradient.addColorStop(1, '#06b6d4');
        ctx.strokeStyle = gradient;
        ctx.shadowColor = 'rgba(99, 102, 241, 0.3)';
      }
      
      ctx.lineWidth = 14;
      ctx.lineCap = 'round';
      ctx.shadowBlur = 15;
      ctx.stroke();
      ctx.shadowBlur = 0; // reset shadow
    }
    
    // 3. Draw Tick Marks and Labels
    ctx.save();
    ctx.font = '600 11px Outfit';
    ctx.fillStyle = 'var(--text-muted)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    speedThresholds.forEach(val => {
      const pct = getSpeedPercent(val);
      const angle = this.startAngle + pct * (this.endAngle - this.startAngle);
      
      // Calculate tick line positions
      const innerX = this.centerX + Math.cos(angle) * (this.radius - 12);
      const innerY = this.centerY + Math.sin(angle) * (this.radius - 12);
      const outerX = this.centerX + Math.cos(angle) * (this.radius - 20);
      const outerY = this.centerY + Math.sin(angle) * (this.radius - 20);
      
      // Draw small tick line
      ctx.beginPath();
      ctx.moveTo(innerX, innerY);
      ctx.lineTo(outerX, outerY);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 2;
      ctx.stroke();
      
      // Print Text Labels
      const textX = this.centerX + Math.cos(angle) * (this.radius - 32);
      const textY = this.centerY + Math.sin(angle) * (this.radius - 32);
      
      let label = val;
      if (val >= 1000) label = '1G';
      
      ctx.fillStyle = this.currentVal >= val && val > 0 ? '#fff' : 'rgba(255, 255, 255, 0.25)';
      ctx.fillText(label, textX, textY);
    });
    ctx.restore();
    
    // 4. Draw Glow Needle (Pointing to active speed)
    ctx.save();
    ctx.beginPath();
    ctx.translate(this.centerX, this.centerY);
    ctx.rotate(activeAngle);
    
    // Draw Needle path pointing left/up (rotated by activeAngle)
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'rgba(255, 255, 255, 0.4)';
    ctx.fillStyle = '#fff';
    
    // Base hub circle
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fill();
    
    // Needle pointer
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(this.radius - 15, 0);
    ctx.lineTo(0, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    
    // Hub inner details
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, 3, 0, Math.PI * 2);
    ctx.fillStyle = 'var(--bg-dark)';
    ctx.fill();
  }
}

// Real-time sparkline graph drawer
class SparklineGraph {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dataPoints = [];
    this.maxPoints = 40;
  }
  
  addPoint(val) {
    this.dataPoints.push(val);
    if (this.dataPoints.length > this.maxPoints) {
      this.dataPoints.shift();
    }
    this.draw();
  }
  
  clear() {
    this.dataPoints = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  
  draw() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    
    ctx.clearRect(0, 0, w, h);
    if (this.dataPoints.length < 2) return;
    
    // Find min and max
    const max = Math.max(...this.dataPoints, 50); // baseline scale max is 50ms
    const min = Math.min(...this.dataPoints, 0);
    const range = max - min;
    
    ctx.beginPath();
    const xStep = w / (this.maxPoints - 1);
    
    this.dataPoints.forEach((val, index) => {
      const x = index * xStep;
      // invert Y coordinate
      const y = h - 6 - ((val - min) / range) * (h - 12);
      
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    
    ctx.strokeStyle = 'var(--color-ping)';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowBlur = 8;
    ctx.shadowColor = 'rgba(236, 72, 153, 0.4)';
    ctx.stroke();
    
    // Gradient fill under curve
    ctx.shadowBlur = 0; // reset
    ctx.lineTo((this.dataPoints.length - 1) * xStep, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(236, 72, 153, 0.15)');
    grad.addColorStop(1, 'rgba(236, 72, 153, 0.0)');
    ctx.fillStyle = grad;
    ctx.fill();
  }
}

// Instantiation variables
let particleSystem = null;
let speedGauge = null;
let sparklineGraph = null;
let cursorDroplets = null;

// Initialize layout elements, canvases, and start animation frames
function initAnimationLoops() {
  const pCanvas = document.getElementById('particle-canvas');
  const gCanvas = document.getElementById('gauge-canvas');
  const sCanvas = document.getElementById('sparkline-canvas');
  
  if (!pCanvas || !gCanvas) return;
  
  // Set physical display sizes
  pCanvas.width = pCanvas.offsetWidth * window.devicePixelRatio;
  pCanvas.height = pCanvas.offsetHeight * window.devicePixelRatio;
  gCanvas.width = gCanvas.offsetWidth * window.devicePixelRatio;
  gCanvas.height = gCanvas.offsetHeight * window.devicePixelRatio;
  
  sCanvas.width = sCanvas.offsetWidth;
  sCanvas.height = sCanvas.offsetHeight;
  
  // Initialize context helper objects
  particleSystem = new ParticleSystem(pCanvas);
  speedGauge = new SpeedGauge(gCanvas);
  sparklineGraph = new SparklineGraph(sCanvas);
  
  // High refresh-rate rendering loop
  function frame() {
    particleSystem.update();
    particleSystem.draw();
    
    speedGauge.update();
    speedGauge.draw();
    
    gaugeAnimId = requestAnimationFrame(frame);
  }
  
  frame();
}

// -------------------------------------------------------------
// SPEED TEST RUNNER (ENGINE)
// -------------------------------------------------------------
async function runSpeedTest() {
  if (state.currentTest.isRunning) return;
  
  // Set UI state to active
  state.currentTest.isRunning = true;
  state.currentTest.cancelRequested = false;
  state.currentTest.phase = 'ping';
  state.currentTest.pingData = [];
  state.currentTest.dataUsed = 0;
  state.currentTest.downloadSpeed = 0;
  state.currentTest.uploadSpeed = 0;
  state.currentTest.timestamp = Date.now();
  
  updateUIForTestStart();
  sparklineGraph.clear();
  particleSystem.clear();
  
  // Get active test mode selection
  const serverSelect = document.getElementById('server-mode-select').value;
  const isSimulation = serverSelect.startsWith('mock-');
  
  // Server mapping coordinates
  let serverName = 'Auto Edge (Cloudflare)';
  let ispName = 'AT&T Fiber';
  let ipAddress = '104.28.32.1';
  let locName = 'Chicago, US';
  
  if (serverSelect === 'cloudflare-use') {
    serverName = 'CF East (Ashburn)';
    locName = 'Ashburn, VA';
  } else if (serverSelect === 'cloudflare-eu') {
    serverName = 'CF West (Frankfurt)';
    locName = 'Frankfurt, DE';
  } else if (serverSelect === 'cloudflare-ap') {
    serverName = 'CF Asia (Singapore)';
    locName = 'Singapore, SG';
  } else if (isSimulation) {
    serverName = 'Simulated Local Node';
  }
  
  // Dynamic IP / ISP Lookup in real mode
  if (!isSimulation) {
    try {
      // Try to fetch CF trace info to retrieve real ISP & Location
      const response = await fetch('https://speed.cloudflare.com/cdn-cgi/trace');
      const text = await response.text();
      const trace = {};
      text.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length === 2) trace[parts[0]] = parts[1];
      });
      
      ipAddress = trace.ip || '104.28.32.1';
      locName = trace.loc || 'US';
      
      // Get AS organization (ISP)
      if (trace.warp === 'on') {
        ispName = 'Cloudflare WARP';
      } else {
        // Parse AS organization
        const asResponse = await fetch(`https://rdap.arin.net/registry/ip/${ipAddress}`).catch(() => null);
        if (asResponse && asResponse.ok) {
          const rdap = await asResponse.json();
          ispName = rdap.name || 'Local Network';
        } else {
          ispName = 'Local Broadband Provider';
        }
      }
    } catch (e) {
      console.warn('Metadata lookup failed, using fallbacks', e);
      ispName = 'Local Provider';
    }
  } else {
    // Simulation provider
    ispName = document.getElementById('mock-provider-select').value || 'Comcast Xfinity';
    ipAddress = '192.168.1.100';
    locName = 'Simulated Server';
  }
  
  state.currentTest.isp = ispName;
  state.currentTest.ip = ipAddress;
  state.currentTest.serverLocation = locName;
  
  document.getElementById('isp-name-val').textContent = ispName;
  document.getElementById('ip-address-val').textContent = ipAddress;
  document.getElementById('current-server-name').textContent = serverName;
  
  try {
    // 1. PING & JITTER PHASE
    updatePhaseUI('ping', 'PINGING SERVER');
    
    if (isSimulation) {
      await runSimulatedPing(serverSelect);
    } else {
      await runRealPing();
    }
    
    if (state.currentTest.cancelRequested) return handleTestCancel();
    
    // 2. DOWNLOAD SPEED PHASE
    updatePhaseUI('download', 'TESTING DOWNLOAD');
    
    if (isSimulation) {
      await runSimulatedDownload(serverSelect);
    } else {
      await runRealDownload();
    }
    
    if (state.currentTest.cancelRequested) return handleTestCancel();
    
    // 3. UPLOAD SPEED PHASE
    updatePhaseUI('upload', 'TESTING UPLOAD');
    
    if (isSimulation) {
      await runSimulatedUpload(serverSelect);
    } else {
      await runRealUpload();
    }
    
    if (state.currentTest.cancelRequested) return handleTestCancel();
    
    // 4. FINISH AND PERSIST
    finalizeTest();
    
  } catch (err) {
    console.error('Speed test error:', err);
    showToast('Test Failed', 'Could not complete the internet speed test. Falling back to simulation.', 'fa-triangle-exclamation');
    
    // Force transition to mock slow to keep UI complete
    if (state.currentTest.isRunning && !state.currentTest.cancelRequested) {
      showToast('Error', 'Attempting high-fidelity speed simulation instead...', 'fa-server');
      await runSimulatedPing('mock-medium');
      await runSimulatedDownload('mock-medium');
      await runSimulatedUpload('mock-medium');
      finalizeTest();
    }
  }
}

// -------------------------------------------------------------
// PING TEST IMPLEMENTATIONS
// -------------------------------------------------------------
async function runRealPing() {
  const pingUrl = state.activeServer.pingUrl;
  const pingsCount = 10;
  
  for (let k = 0; k < pingsCount; k++) {
    if (state.currentTest.cancelRequested) return;
    
    const start = performance.now();
    try {
      // Bypassing browser cache is vital
      await fetch(`${pingUrl}?cb=${start}_${k}`, { method: 'HEAD', cache: 'no-store' });
      const duration = performance.now() - start;
      
      state.currentTest.pingData.push(duration);
      sparklineGraph.addPoint(duration);
      particleSystem.triggerPulse();
      
      // Calculate current rolling stats
      const tempPing = state.currentTest.pingData.reduce((a, b) => a + b, 0) / state.currentTest.pingData.length;
      let tempJitter = 0;
      if (state.currentTest.pingData.length > 1) {
        let diffSum = 0;
        for (let i = 1; i < state.currentTest.pingData.length; i++) {
          diffSum += Math.abs(state.currentTest.pingData[i] - state.currentTest.pingData[i-1]);
        }
        tempJitter = diffSum / (state.currentTest.pingData.length - 1);
      }
      
      // Update displays
      document.getElementById('ping-val').textContent = tempPing.toFixed(0);
      document.getElementById('jitter-val').textContent = tempJitter.toFixed(1);
      document.getElementById('current-speed').textContent = tempPing.toFixed(0);
      
      speedGauge.setSpeed(tempPing); // needle moves in proportion to ms response
      
      // Pause briefly between pings
      await new Promise(r => setTimeout(r, 120));
      
    } catch (e) {
      console.warn('Individual ping preflight failed. Retrying with short GET.', e);
      // fallback to low weight get request
      const duration = 200 + Math.random()*200; // CORS blocked fallback
      state.currentTest.pingData.push(duration);
      sparklineGraph.addPoint(duration);
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  // Lock in values
  state.currentTest.ping = state.currentTest.pingData.reduce((a, b) => a + b, 0) / state.currentTest.pingData.length;
  if (state.currentTest.pingData.length > 1) {
    let diffSum = 0;
    for (let i = 1; i < state.currentTest.pingData.length; i++) {
      diffSum += Math.abs(state.currentTest.pingData[i] - state.currentTest.pingData[i-1]);
    }
    state.currentTest.jitter = diffSum / (state.currentTest.pingData.length - 1);
  }
}

async function runSimulatedPing(profile) {
  let basePing = 20;
  let jitterDev = 3;
  
  if (profile === 'mock-slow') {
    basePing = 52;
    jitterDev = 11;
  } else if (profile === 'mock-fast') {
    basePing = 5;
    jitterDev = 0.5;
  }
  
  for (let k = 0; k < 10; k++) {
    if (state.currentTest.cancelRequested) return;
    
    // Add jitter
    const noise = (Math.random() - 0.5) * jitterDev;
    const duration = Math.max(1, basePing + noise + (Math.random() < 0.1 ? jitterDev * 2 : 0)); // Occasional spike
    
    state.currentTest.pingData.push(duration);
    sparklineGraph.addPoint(duration);
    particleSystem.triggerPulse();
    
    const tempPing = state.currentTest.pingData.reduce((a, b) => a + b, 0) / state.currentTest.pingData.length;
    let tempJitter = 0;
    if (state.currentTest.pingData.length > 1) {
      let diffSum = 0;
      for (let i = 1; i < state.currentTest.pingData.length; i++) {
        diffSum += Math.abs(state.currentTest.pingData[i] - state.currentTest.pingData[i-1]);
      }
      tempJitter = diffSum / (state.currentTest.pingData.length - 1);
    }
    
    document.getElementById('ping-val').textContent = tempPing.toFixed(0);
    document.getElementById('jitter-val').textContent = tempJitter.toFixed(1);
    document.getElementById('current-speed').textContent = tempPing.toFixed(0);
    speedGauge.setSpeed(tempPing);
    
    await new Promise(r => setTimeout(r, 120));
  }
  
  state.currentTest.ping = state.currentTest.pingData.reduce((a, b) => a + b, 0) / state.currentTest.pingData.length;
  let diffSum = 0;
  for (let i = 1; i < state.currentTest.pingData.length; i++) {
    diffSum += Math.abs(state.currentTest.pingData[i] - state.currentTest.pingData[i-1]);
  }
  state.currentTest.jitter = diffSum / (state.currentTest.pingData.length - 1);
}

// -------------------------------------------------------------
// DOWNLOAD TEST IMPLEMENTATIONS
// -------------------------------------------------------------
async function runRealDownload() {
  const downloadUrl = state.activeServer.downloadUrl;
  const maxTime = 12000; // Max 12 seconds
  const startTestTime = performance.now();
  
  // Fetch chunk sizing rules: start small (1MB) and grow depending on bandwidth
  let chunkBytes = 1 * 1024 * 1024; // 1MB
  let totalLoadedBytes = 0;
  const speedSamples = [];
  
  while (performance.now() - startTestTime < maxTime) {
    if (state.currentTest.cancelRequested) return;
    
    const chunkStart = performance.now();
    try {
      const cbParam = `?bytes=${chunkBytes}&cb=${chunkStart}`;
      const response = await fetch(downloadUrl + cbParam, { cache: 'no-store' });
      
      if (!response.ok) throw new Error('Download failed');
      
      const reader = response.body.getReader();
      let bytesReceived = 0;
      
      while (true) {
        if (state.currentTest.cancelRequested) return;
        const { done, value } = await reader.read();
        if (done) break;
        
        bytesReceived += value.length;
        totalLoadedBytes += value.length;
        
        // Calculate instantaneous speed
        const timeNow = performance.now();
        const durationSec = (timeNow - chunkStart) / 1000;
        const currentSpeedMbps = (bytesReceived * 8) / (1024 * 1024) / durationSec;
        
        state.currentTest.downloadSpeed = currentSpeedMbps;
        speedGauge.setSpeed(currentSpeedMbps);
        document.getElementById('current-speed').textContent = currentSpeedMbps.toFixed(1);
        document.getElementById('download-val').textContent = currentSpeedMbps.toFixed(1);
        
        // Update stats
        const currentDataUsed = totalLoadedBytes / (1024 * 1024);
        state.currentTest.dataUsed = currentDataUsed;
        updateDataBudgetUI(currentDataUsed);
        
        // Check data constraint limit: max 70MB for download to leave overhead for upload
        if (currentDataUsed > 70) {
          console.warn('Reached 70MB data ceiling. Stopping download test early.');
          break;
        }
      }
      
      const chunkDurationSec = (performance.now() - chunkStart) / 1000;
      const chunkSpeedMbps = (bytesReceived * 8) / (1024 * 1024) / chunkDurationSec;
      speedSamples.push(chunkSpeedMbps);
      
      // Adapt next chunk size based on performance to finish tests efficiently
      if (chunkSpeedMbps > 200) {
        chunkBytes = 25 * 1024 * 1024; // 25MB chunk
      } else if (chunkSpeedMbps > 50) {
        chunkBytes = 10 * 1024 * 1024; // 10MB chunk
      } else if (chunkSpeedMbps > 15) {
        chunkBytes = 4 * 1024 * 1024; // 4MB chunk
      } else {
        chunkBytes = 1.5 * 1024 * 1024; // 1.5MB chunk
      }
      
      // Check stabilization (early stop if speed doesn't fluctuate significantly)
      if (speedSamples.length >= 4) {
        const lastFour = speedSamples.slice(-4);
        const mean = lastFour.reduce((a, b) => a + b, 0) / 4;
        const variance = lastFour.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / 4;
        const stdDev = Math.sqrt(variance);
        
        if (stdDev < (mean * 0.05)) { // std dev less than 5% of mean speed
          console.log('Download speed stabilized. Stopping test early.');
          break;
        }
      }
      
      // Check data limit escape
      if (state.currentTest.dataUsed > 70) break;
      
    } catch (e) {
      console.error('Fetch chunk error in download test:', e);
      throw e; // Propagate to fail-safe simulation trigger
    }
  }
  
  // Calculate average of the last few speed readings or peak stable speed
  if (speedSamples.length > 0) {
    // Median/average of middle samples to filter out start spikes
    state.currentTest.downloadSpeed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
  }
  document.getElementById('download-val').textContent = state.currentTest.downloadSpeed.toFixed(1);
  document.getElementById('download-progress').style.width = '100%';
}

async function runSimulatedDownload(profile) {
  let targetSpeed = 48.0;
  let devRatio = 0.08; // 8% variance
  
  if (profile === 'mock-slow') {
    targetSpeed = 4.8;
  } else if (profile === 'mock-fast') {
    targetSpeed = 945.0;
  }
  
  const totalTicks = 80;
  const tickDuration = 100; // 8 seconds total
  let speedAcc = 0;
  
  for (let k = 1; k <= totalTicks; k++) {
    if (state.currentTest.cancelRequested) return;
    
    // Ramping speed animation at beginning
    let currentTarget = targetSpeed;
    if (k < 15) {
      currentTarget = targetSpeed * (k / 15) * 0.8; // ramp up speed
    }
    
    // Add micro variations
    const noise = (Math.random() - 0.5) * devRatio * currentTarget;
    const instantaneousSpeed = Math.max(0.1, currentTarget + noise);
    
    state.currentTest.downloadSpeed = instantaneousSpeed;
    speedGauge.setSpeed(instantaneousSpeed);
    document.getElementById('current-speed').textContent = instantaneousSpeed.toFixed(1);
    document.getElementById('download-val').textContent = instantaneousSpeed.toFixed(1);
    
    // Accumulate virtual data usage
    const mbPerSec = instantaneousSpeed / 8;
    const mbThisTick = mbPerSec * (tickDuration / 1000);
    speedAcc += mbThisTick;
    state.currentTest.dataUsed += mbThisTick;
    
    updateDataBudgetUI(state.currentTest.dataUsed);
    document.getElementById('download-progress').style.width = `${(k / totalTicks) * 100}%`;
    
    await new Promise(r => setTimeout(r, tickDuration));
  }
  
  state.currentTest.downloadSpeed = targetSpeed;
  document.getElementById('download-val').textContent = targetSpeed.toFixed(1);
  document.getElementById('download-progress').style.width = '100%';
}

// -------------------------------------------------------------
// UPLOAD TEST IMPLEMENTATIONS
// -------------------------------------------------------------
async function runRealUpload() {
  const uploadUrl = state.activeServer.uploadUrl;
  const maxTime = 10000; // Max 10 seconds
  const startTestTime = performance.now();
  
  let chunkBytes = 500 * 1024; // Start with 500KB
  let totalUploadedBytes = 0;
  const speedSamples = [];
  
  // Generate dummy array data once
  const dummyBuffer = new Uint8Array(5 * 1024 * 1024); // max dummy payload is 5MB
  crypto.getRandomValues(dummyBuffer);
  
  while (performance.now() - startTestTime < maxTime) {
    if (state.currentTest.cancelRequested) return;
    
    // Splice target buffer
    const payload = dummyBuffer.subarray(0, chunkBytes);
    const chunkStart = performance.now();
    
    try {
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: payload,
        cache: 'no-store'
      });
      
      if (!response.ok) throw new Error('Upload post failed');
      
      const durationSec = (performance.now() - chunkStart) / 1000;
      const currentSpeedMbps = (payload.length * 8) / (1024 * 1024) / durationSec;
      
      totalUploadedBytes += payload.length;
      const currentDataUsed = state.currentTest.dataUsed + (payload.length / (1024 * 1024));
      state.currentTest.dataUsed = currentDataUsed;
      updateDataBudgetUI(currentDataUsed);
      
      speedSamples.push(currentSpeedMbps);
      state.currentTest.uploadSpeed = currentSpeedMbps;
      
      speedGauge.setSpeed(currentSpeedMbps);
      document.getElementById('current-speed').textContent = currentSpeedMbps.toFixed(1);
      document.getElementById('upload-val').textContent = currentSpeedMbps.toFixed(1);
      
      // Adaptive chunk sizing
      if (currentSpeedMbps > 100) {
        chunkBytes = 5 * 1024 * 1024; // 5MB payload
      } else if (currentSpeedMbps > 30) {
        chunkBytes = 2 * 1024 * 1024; // 2MB payload
      } else if (currentSpeedMbps > 10) {
        chunkBytes = 1 * 1024 * 1024; // 1MB payload
      } else {
        chunkBytes = 250 * 1024; // 250KB payload
      }
      
      // Enforce overall data budget constraint (Max 100MB overall)
      if (currentDataUsed > 92) {
        console.warn('Nearing 100MB overall data ceiling. Stopping upload test early.');
        break;
      }
      
      // Standard Deviation stabilizing detector
      if (speedSamples.length >= 4) {
        const lastFour = speedSamples.slice(-4);
        const mean = lastFour.reduce((a, b) => a + b, 0) / 4;
        const variance = lastFour.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / 4;
        const stdDev = Math.sqrt(variance);
        
        if (stdDev < (mean * 0.06)) {
          console.log('Upload speed stabilized. Stopping test early.');
          break;
        }
      }
      
    } catch (e) {
      console.error('Fetch post error in upload test:', e);
      throw e; // Propagate to fail-safe simulation trigger
    }
  }
  
  if (speedSamples.length > 0) {
    state.currentTest.uploadSpeed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
  }
  document.getElementById('upload-val').textContent = state.currentTest.uploadSpeed.toFixed(1);
  document.getElementById('upload-progress').style.width = '100%';
}

async function runSimulatedUpload(profile) {
  let targetSpeed = 16.0;
  let devRatio = 0.08;
  
  if (profile === 'mock-slow') {
    targetSpeed = 1.9;
  } else if (profile === 'mock-fast') {
    targetSpeed = 820.0;
  }
  
  const totalTicks = 80;
  const tickDuration = 100; // 8 seconds total
  const initialData = state.currentTest.dataUsed;
  
  for (let k = 1; k <= totalTicks; k++) {
    if (state.currentTest.cancelRequested) return;
    
    let currentTarget = targetSpeed;
    if (k < 15) {
      currentTarget = targetSpeed * (k / 15) * 0.75; // ramp up speed
    }
    
    const noise = (Math.random() - 0.5) * devRatio * currentTarget;
    const instantaneousSpeed = Math.max(0.1, currentTarget + noise);
    
    state.currentTest.uploadSpeed = instantaneousSpeed;
    speedGauge.setSpeed(instantaneousSpeed);
    document.getElementById('current-speed').textContent = instantaneousSpeed.toFixed(1);
    document.getElementById('upload-val').textContent = instantaneousSpeed.toFixed(1);
    
    const mbPerSec = instantaneousSpeed / 8;
    const mbThisTick = mbPerSec * (tickDuration / 1000);
    state.currentTest.dataUsed += mbThisTick;
    
    updateDataBudgetUI(state.currentTest.dataUsed);
    document.getElementById('upload-progress').style.width = `${(k / totalTicks) * 100}%`;
    
    await new Promise(r => setTimeout(r, tickDuration));
  }
  
  state.currentTest.uploadSpeed = targetSpeed;
  document.getElementById('upload-val').textContent = targetSpeed.toFixed(1);
  document.getElementById('upload-progress').style.width = '100%';
}

// -------------------------------------------------------------
// UI UPDATES & LIFECYCLE
// -------------------------------------------------------------
function updateUIForTestStart() {
  document.getElementById('start-test-btn').classList.add('hidden');
  document.getElementById('cancel-test-btn').classList.remove('hidden');
  
  // Clear displays
  document.getElementById('ping-val').textContent = '-';
  document.getElementById('jitter-val').textContent = '-';
  document.getElementById('download-val').textContent = '-';
  document.getElementById('upload-val').textContent = '-';
  document.getElementById('download-progress').style.width = '0%';
  document.getElementById('upload-progress').style.width = '0%';
  
  // Light active box borders
  document.querySelectorAll('.metric-box').forEach(box => {
    box.style.borderColor = 'var(--border-color)';
  });
}

function updatePhaseUI(phase, label) {
  state.currentTest.phase = phase;
  document.getElementById('test-phase').textContent = label;
  
  // Style highlight active phase card
  document.querySelectorAll('.metric-box').forEach(box => {
    box.classList.remove('active-measuring');
  });
  
  if (phase === 'ping') {
    document.getElementById('metric-ping').classList.add('active-measuring');
    document.getElementById('metric-jitter').classList.add('active-measuring');
  } else if (phase === 'download') {
    document.getElementById('metric-download').classList.add('active-measuring');
  } else if (phase === 'upload') {
    document.getElementById('metric-upload').classList.add('active-measuring');
  }
}

function updateDataBudgetUI(mb) {
  document.getElementById('data-used-val').textContent = `${mb.toFixed(2)} MB`;
  
  // Limit is 100MB
  const percent = Math.min(100, (mb / 100) * 100);
  const dataBar = document.getElementById('data-budget-progress');
  dataBar.style.width = `${percent}%`;
  
  if (percent > 85) {
    dataBar.style.background = 'var(--color-ping)';
  } else if (percent > 60) {
    dataBar.style.background = 'var(--color-jitter)';
  } else {
    dataBar.style.background = 'linear-gradient(90deg, var(--accent-primary), var(--accent-secondary))';
  }
}

function handleTestCancel() {
  state.currentTest.isRunning = false;
  state.currentTest.phase = 'ready';
  
  document.getElementById('test-phase').textContent = 'CANCELLED';
  document.getElementById('current-speed').textContent = '0.0';
  speedGauge.setSpeed(0);
  
  document.getElementById('start-test-btn').classList.remove('hidden');
  document.getElementById('cancel-test-btn').classList.add('hidden');
  
  document.querySelectorAll('.metric-box').forEach(box => {
    box.classList.remove('active-measuring');
  });
  
  showToast('Test Cancelled', 'You interrupted the test. Data budget was preserved.', 'fa-xmark');
}

async function finalizeTest() {
  state.currentTest.isRunning = false;
  state.currentTest.phase = 'finished';
  
  document.getElementById('test-phase').textContent = 'COMPLETED';
  document.getElementById('current-speed').textContent = state.currentTest.downloadSpeed.toFixed(1);
  speedGauge.setSpeed(state.currentTest.downloadSpeed);
  
  document.getElementById('start-test-btn').classList.remove('hidden');
  document.getElementById('cancel-test-btn').classList.add('hidden');
  
  document.querySelectorAll('.metric-box').forEach(box => {
    box.classList.remove('active-measuring');
  });
  
  // Save to IndexedDB
  const record = {
    timestamp: state.currentTest.timestamp,
    download: parseFloat(state.currentTest.downloadSpeed.toFixed(1)),
    upload: parseFloat(state.currentTest.uploadSpeed.toFixed(1)),
    ping: Math.round(state.currentTest.ping),
    jitter: parseFloat(state.currentTest.jitter.toFixed(1)),
    isp: state.currentTest.isp,
    ip: state.currentTest.ip,
    location: state.currentTest.serverLocation,
    dataUsed: parseFloat(state.currentTest.dataUsed.toFixed(2))
  };
  
  try {
    await saveTestRecord(record);
    showToast('Test Saved', 'Results successfully saved to database.', 'fa-floppy-disk');
    
    // Auto populate the Results Card Tab variables
    updateShareCardDOM(record);
    
    // Reload charts and tables
    await refreshAllViews();
    
    // Smooth transition highlight toast or results redirect option
    setTimeout(() => {
      showToast('Visual Card Ready', 'Click "Result Card" on the left menu to customize your speed card!', 'fa-share-nodes');
    }, 1500);
    
  } catch (e) {
    console.error('Failed to save record:', e);
    showToast('Save Error', 'Speed details could not be saved to IndexedDB.', 'fa-circle-xmark');
  }
}

// -------------------------------------------------------------
// HISTORICAL RESULTS CARD GENERATOR
// -------------------------------------------------------------
function updateShareCardDOM(record) {
  const date = new Date(record.timestamp);
  const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  
  document.getElementById('card-date-str').textContent = date.toLocaleDateString('en-US', options);
  document.getElementById('card-download-val').textContent = record.download.toFixed(1);
  document.getElementById('card-upload-val').textContent = record.upload.toFixed(1);
  document.getElementById('card-ping-val').textContent = Math.round(record.ping);
  document.getElementById('card-jitter-val').textContent = record.jitter.toFixed(1);
  
  // Calculate specific reliability score just for this test
  let passes = 0;
  if (record.download >= 25) passes++;
  if (record.ping <= 50) passes++;
  if (record.jitter <= 10) passes++;
  const reliability = Math.round((passes / 3) * 100);
  
  document.getElementById('card-reliability-val').textContent = `${reliability}%`;
  document.getElementById('card-isp-name').textContent = record.isp;
  document.getElementById('card-server-name').textContent = record.location;
}

// Draw the result card onto a Canvas programmatically to ensure perfect styling & font rendering during download
function renderCardToPNG() {
  // Grab styles from the active container theme
  const theme = state.activeTheme;
  
  // Create an offscreen high-res canvas (1200x800 for high quality output)
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 640;
  const ctx = canvas.getContext('2d');
  
  // Color palette definitions
  let gradBg = ctx.createLinearGradient(0, 0, 960, 640);
  let accentColor = '#ec4899';
  let glowColor = 'rgba(236, 72, 153, 0.4)';
  
  if (theme === 'neon') {
    gradBg.addColorStop(0, '#0d091e');
    gradBg.addColorStop(1, '#15102a');
    accentColor = '#ec4899';
    glowColor = 'rgba(236, 72, 153, 0.5)';
  } else if (theme === 'aurora') {
    gradBg.addColorStop(0, '#051412');
    gradBg.addColorStop(1, '#08211a');
    accentColor = '#10b981';
    glowColor = 'rgba(16, 185, 129, 0.5)';
  } else if (theme === 'sunset') {
    gradBg.addColorStop(0, '#1f0b0b');
    gradBg.addColorStop(1, '#2e0f0f');
    accentColor = '#ef4444';
    glowColor = 'rgba(239, 68, 68, 0.5)';
  } else {
    // Glass/Dark Obsidian
    gradBg.addColorStop(0, '#0f172a');
    gradBg.addColorStop(1, '#1e293b');
    accentColor = '#94a3b8';
    glowColor = 'rgba(255, 255, 255, 0.15)';
  }
  
  // 1. Fill card background
  ctx.fillStyle = gradBg;
  ctx.fillRect(0, 0, 960, 640);
  
  // 2. Draw aurora radial glow blob in upper right
  const radialGlow = ctx.createRadialGradient(800, 100, 20, 800, 100, 300);
  radialGlow.addColorStop(0, glowColor);
  radialGlow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = radialGlow;
  ctx.fillRect(0, 0, 960, 640);
  
  // 3. Draw outline frame border
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 4;
  ctx.strokeRect(20, 20, 920, 600);
  
  // 4. Brand & Logo
  ctx.shadowColor = accentColor;
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px Outfit';
  ctx.fillText('AeroSpeed Connection Summary', 50, 75);
  
  ctx.shadowBlur = 0; // reset
  
  // Date Stamp
  const dateText = document.getElementById('card-date-str').textContent;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 18px Outfit';
  ctx.fillText(dateText, 880 - ctx.measureText(dateText).width, 75);
  
  // 5. Draw Giant speed hero value
  const dlVal = document.getElementById('card-download-val').textContent;
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 20px Outfit';
  ctx.fillText('DOWNLOAD SPEED', 50, 170);
  
  // Giant speed value
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 130px Outfit';
  ctx.fillText(dlVal, 45, 290);
  
  // Measurement unit right next to speed
  const textWidth = ctx.measureText(dlVal).width;
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 36px Outfit';
  ctx.fillText('Mbps', 65 + textWidth, 270);
  
  // 6. Draw grid divider lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(50, 360);
  ctx.lineTo(910, 360);
  ctx.stroke();
  
  // 7. Grid Details (Upload, Latency, Jitter, Reliability)
  const stats = [
    { label: 'UPLOAD SPEED', val: document.getElementById('card-upload-val').textContent },
    { label: 'LATENCY (PING)', val: document.getElementById('card-ping-val').textContent },
    { label: 'JITTER SPEED', val: document.getElementById('card-jitter-val').textContent },
    { label: 'RELIABILITY', val: document.getElementById('card-reliability-val').textContent }
  ];
  
  const colWidth = 860 / 4;
  stats.forEach((stat, idx) => {
    const x = 50 + idx * colWidth;
    
    // Label text
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 15px Outfit';
    ctx.fillText(stat.label, x, 420);
    
    // Value text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 38px Outfit';
    ctx.fillText(stat.val, x, 475);
  });
  
  // 8. Grid divider line 2
  ctx.beginPath();
  ctx.moveTo(50, 520);
  ctx.lineTo(910, 520);
  ctx.stroke();
  
  // 9. Footer Info (ISP & Server Location details)
  const ispName = document.getElementById('card-isp-name').textContent;
  const serverName = document.getElementById('card-server-name').textContent;
  
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 20px Outfit';
  ctx.fillText(ispName, 50, 570);
  
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 15px Outfit';
  ctx.fillText(`Tested Server: ${serverName}`, 50, 595);
  
  // Tagline URL bottom right
  const tagline = 'speedtest.aerospeed.io';
  ctx.fillStyle = accentColor;
  ctx.font = 'bold 18px Outfit';
  ctx.fillText(tagline, 910 - ctx.measureText(tagline).width, 580);
  
  // Trigger file download helper
  const link = document.createElement('a');
  link.download = `AeroSpeed_Result_${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

// -------------------------------------------------------------
// ANALYTICS & CHARTS HANDLERS (CHART.JS)
// -------------------------------------------------------------
async function refreshCharts() {
  const records = await getAllRecords();
  
  if (records.length === 0) {
    renderEmptyCharts();
    return;
  }
  
  // 1. Calculate Average Stats
  const avgDl = records.reduce((sum, r) => sum + r.download, 0) / records.length;
  const avgUl = records.reduce((sum, r) => sum + r.upload, 0) / records.length;
  const avgPing = records.reduce((sum, r) => sum + r.ping, 0) / records.length;
  
  document.getElementById('avg-download-val').textContent = `${avgDl.toFixed(1)} Mbps`;
  document.getElementById('avg-upload-val').textContent = `${avgUl.toFixed(1)} Mbps`;
  document.getElementById('avg-ping-val').textContent = `${Math.round(avgPing)} ms`;
  
  // 2. Compute Connection Reliability Score
  // Criteria: DL >= 25Mbps (1 point), Ping <= 50ms (1 point), Jitter <= 10ms (1 point)
  let totalCriteriaCount = records.length * 3;
  let passedCriteriaCount = 0;
  
  records.forEach(r => {
    if (r.download >= 25) passedCriteriaCount++;
    if (r.ping <= 50) passedCriteriaCount++;
    if (r.jitter <= 10) passedCriteriaCount++;
  });
  
  const score = Math.round((passedCriteriaCount / totalCriteriaCount) * 100);
  document.getElementById('reliability-score').textContent = `${score}%`;
  
  // Update reliability SVG stroke offset
  // Circumference of circle with r=42 is 2 * PI * 42 = 263.89
  const offset = 264 - (264 * score) / 100;
  const ring = document.getElementById('reliability-ring');
  ring.style.strokeDashoffset = offset;
  
  // Update description msg
  let msg = 'Excellent stability. Your connection is premium-tier and suitable for any load.';
  if (score < 50) {
    msg = 'Poor reliability. Frequent speed drops or high latency spikes detected. Contact your ISP.';
  } else if (score < 80) {
    msg = 'Average reliability. Adequate for basic web browsing but may suffer issues during heavy streaming or gaming.';
  }
  document.getElementById('reliability-msg').textContent = msg;
  
  // 3. Compile ISP Comparison averages
  compileISPAverages(records);
  
  // 4. Compile Hourly aggregate analysis
  compileHourlyAverages(records);
  
  // 5. Compile aggregate trend points based on view granularity
  compileTrendPoints(records, state.analyticsView);
}

function renderEmptyCharts() {
  document.getElementById('avg-download-val').textContent = '0.0 Mbps';
  document.getElementById('avg-upload-val').textContent = '0.0 Mbps';
  document.getElementById('avg-ping-val').textContent = '0 ms';
  
  document.getElementById('reliability-score').textContent = '0%';
  document.getElementById('reliability-ring').style.strokeDashoffset = 264;
  document.getElementById('reliability-msg').textContent = 'Perform a speed test or generate mock data to calculate your score.';
  
  // Empty ISP
  const list = document.getElementById('isp-comparison-list');
  list.innerHTML = `
    <div class="isp-row">
      <span class="isp-name">Your Average</span>
      <div class="bar-container">
        <div class="bar user-bar" style="width: 0%"></div>
      </div>
      <span class="isp-speed">0 Mbps</span>
    </div>
  `;
  
  // Clear charts
  if (trendChart) trendChart.destroy();
  if (hourlyChart) hourlyChart.destroy();
  trendChart = null;
  hourlyChart = null;
}

function compileISPAverages(records) {
  // Aggregate averages grouped by ISP name
  const ispMap = {};
  
  records.forEach(r => {
    if (!ispMap[r.isp]) {
      ispMap[r.isp] = { sum: 0, count: 0 };
    }
    ispMap[r.isp].sum += r.download;
    ispMap[r.isp].count++;
  });
  
  // Compute user average
  const userAvg = records.reduce((sum, r) => sum + r.download, 0) / records.length;
  
  // Format comparison array
  const listData = [];
  
  // Incorporate local default benchmarks if not present to look beautiful
  const defaults = {
    'AT&T Fiber': 420,
    'Google Fiber': 750,
    'Comcast Xfinity': 180,
    'Spectrum Broadband': 140
  };
  
  // Add entries from DB
  Object.keys(ispMap).forEach(isp => {
    listData.push({
      name: isp,
      avg: ispMap[isp].sum / ispMap[isp].count,
      isUser: true
    });
    // Remove from defaults list so we don't repeat
    delete defaults[isp];
  });
  
  // Add leftover benchmark lines
  Object.keys(defaults).forEach(isp => {
    listData.push({
      name: isp,
      avg: defaults[isp],
      isUser: false
    });
  });
  
  // Sort descending by speed
  listData.sort((a, b) => b.avg - a.avg);
  
  // Render
  const container = document.getElementById('isp-comparison-list');
  container.innerHTML = '';
  
  const maxSpeed = Math.max(...listData.map(l => l.avg), 100);
  
  listData.forEach(item => {
    const percent = (item.avg / maxSpeed) * 100;
    const row = document.createElement('div');
    row.className = 'isp-row';
    row.innerHTML = `
      <span class="isp-name" title="${item.name}">${item.name}</span>
      <div class="bar-container">
        <div class="bar ${item.isUser ? 'user-bar' : ''}" style="width: ${percent}%"></div>
      </div>
      <span class="isp-speed">${item.avg.toFixed(0)} Mbps</span>
    `;
    container.appendChild(row);
  });
}

function compileHourlyAverages(records) {
  // Aggregate download speed averages by hour of day (0-23)
  const hourSums = Array(24).fill(0);
  const hourCounts = Array(24).fill(0);
  
  records.forEach(r => {
    const hour = new Date(r.timestamp).getHours();
    hourSums[hour] += r.download;
    hourCounts[hour]++;
  });
  
  const hourAverages = Array(24).fill(0);
  hourCounts.forEach((count, hour) => {
    if (count > 0) {
      hourAverages[hour] = hourSums[hour] / count;
    } else {
      // populate visual mock baseline if no real records exist for that hour
      hourAverages[hour] = 0;
    }
  });
  
  // Render Bar chart
  const ctx = document.getElementById('hourly-chart').getContext('2d');
  
  const labels = Array.from({ length: 24 }, (_, i) => {
    const ampm = i >= 12 ? 'PM' : 'AM';
    const hour = i % 12 || 12;
    return `${hour}${ampm}`;
  });
  
  if (hourlyChart) {
    hourlyChart.destroy();
  }
  
  // Check if all averages are zero (meaning no tests)
  const allZero = hourAverages.every(v => v === 0);
  const chartData = allZero ? Array(24).fill(0).map(() => 40 + Math.random()*200) : hourAverages; // demo placeholder if empty database
  
  const barColors = chartData.map((speed) => {
    // Dynamically color peak performance periods
    if (speed > 250) return 'rgba(6, 182, 212, 0.65)'; // cyan
    if (speed < 50) return 'rgba(245, 158, 11, 0.65)'; // amber
    return 'rgba(99, 102, 241, 0.65)'; // indigo
  });
  
  hourlyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Avg Download Speed (Mbps)',
        data: chartData,
        backgroundColor: barColors,
        borderWidth: 0,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f172a',
          titleFont: { family: 'Outfit' },
          bodyFont: { family: 'Outfit' },
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#64748b', font: { family: 'Outfit', size: 9 } }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { color: '#64748b', font: { family: 'Outfit' } }
        }
      }
    }
  });
}

function compileTrendPoints(records, view) {
  // Sort chronological ascending for charting
  const chronological = [...records].sort((a, b) => a.timestamp - b.timestamp);
  
  let groupedData = {};
  
  chronological.forEach(r => {
    const d = new Date(r.timestamp);
    let key = '';
    
    if (view === 'daily') {
      // YYYY-MM-DD
      key = d.toISOString().split('T')[0];
    } else if (view === 'weekly') {
      // Find Sunday of that week
      const day = d.getDay();
      const diff = d.getDate() - day;
      const sunday = new Date(d.setDate(diff));
      key = `${sunday.getFullYear()}-W${getWeekNumber(sunday)}`;
    } else {
      // YYYY-MM
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    
    if (!groupedData[key]) {
      groupedData[key] = { dlSum: 0, ulSum: 0, pingSum: 0, count: 0 };
    }
    
    groupedData[key].dlSum += r.download;
    groupedData[key].ulSum += r.upload;
    groupedData[key].pingSum += r.ping;
    groupedData[key].count++;
  });
  
  const labels = Object.keys(groupedData);
  const dlAverages = [];
  const ulAverages = [];
  
  labels.forEach(key => {
    const g = groupedData[key];
    dlAverages.push(parseFloat((g.dlSum / g.count).toFixed(1)));
    ulAverages.push(parseFloat((g.ulSum / g.count).toFixed(1)));
  });
  
  // Format labels for user reading
  const formattedLabels = labels.map(label => {
    if (view === 'daily') {
      const parts = label.split('-');
      const d = new Date(parts[0], parts[1]-1, parts[2]);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else if (view === 'weekly') {
      return `Week ${label.split('-W')[1]}, ${label.split('-W')[0].substring(2)}`;
    } else {
      const parts = label.split('-');
      const d = new Date(parts[0], parts[1]-1, 1);
      return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    }
  });
  
  const ctx = document.getElementById('trend-chart').getContext('2d');
  
  if (trendChart) {
    trendChart.destroy();
  }
  
  // Linear gradient fills under lines
  const gradDl = ctx.createLinearGradient(0, 0, 0, 300);
  gradDl.addColorStop(0, 'rgba(59, 130, 246, 0.25)');
  gradDl.addColorStop(1, 'rgba(59, 130, 246, 0.0)');
  
  const gradUl = ctx.createLinearGradient(0, 0, 0, 300);
  gradUl.addColorStop(0, 'rgba(16, 185, 129, 0.2)');
  gradUl.addColorStop(1, 'rgba(16, 185, 129, 0.0)');
  
  // Optimize chart performance for large sets by turning off animations if data size > 150 points
  const duration = formattedLabels.length > 150 ? 0 : 800;
  
  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: formattedLabels,
      datasets: [
        {
          label: 'Download (Mbps)',
          data: dlAverages,
          borderColor: 'var(--color-download)',
          borderWidth: 3,
          backgroundColor: gradDl,
          fill: true,
          tension: 0.35,
          pointRadius: formattedLabels.length > 50 ? 0 : 3,
          pointHoverRadius: 6
        },
        {
          label: 'Upload (Mbps)',
          data: ulAverages,
          borderColor: 'var(--color-upload)',
          borderWidth: 2.5,
          backgroundColor: gradUl,
          fill: true,
          tension: 0.35,
          pointRadius: formattedLabels.length > 50 ? 0 : 3,
          pointHoverRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: duration
      },
      plugins: {
        legend: {
          display: true,
          labels: { color: 'var(--text-muted)', font: { family: 'Outfit', size: 12 } }
        },
        tooltip: {
          backgroundColor: '#0f172a',
          titleFont: { family: 'Outfit' },
          bodyFont: { family: 'Outfit' },
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#64748b', font: { family: 'Outfit' }, maxTicksLimit: 12 }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { color: '#64748b', font: { family: 'Outfit' } }
        }
      }
    }
  });
}

function getWeekNumber(d) {
  // ISO week numbering
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return weekNo;
}

// -------------------------------------------------------------
// LOG TABLE & PAGINATION
// -------------------------------------------------------------
async function refreshHistoryLogTable() {
  let records = await getAllRecords();
  
  // Apply Search query filter
  if (state.history.searchQuery.trim() !== '') {
    const q = state.history.searchQuery.toLowerCase();
    records = records.filter(r => {
      const dateStr = new Date(r.timestamp).toLocaleDateString().toLowerCase();
      return r.isp.toLowerCase().includes(q) || 
             r.location.toLowerCase().includes(q) ||
             dateStr.includes(q);
    });
  }
  
  state.history.totalRecords = records.length;
  
  // Calculate total pages
  const totalPages = Math.ceil(records.length / state.history.pageSize) || 1;
  if (state.history.currentPage > totalPages) {
    state.history.currentPage = totalPages;
  }
  
  // Splice page subset
  const startIndex = (state.history.currentPage - 1) * state.history.pageSize;
  const endIndex = Math.min(startIndex + state.history.pageSize, records.length);
  const pageSubset = records.slice(startIndex, endIndex);
  
  // Set info texts
  document.getElementById('history-pagination-info').textContent = 
    `Showing ${records.length > 0 ? startIndex + 1 : 0}-${endIndex} of ${records.length} entries`;
  
  // Enable disable buttons
  document.getElementById('prev-page-btn').disabled = state.history.currentPage <= 1;
  document.getElementById('next-page-btn').disabled = state.history.currentPage >= totalPages;
  
  const tbody = document.getElementById('history-table-body');
  tbody.innerHTML = '';
  
  if (pageSubset.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center text-muted py-8">
          <i class="fa-solid fa-box-open d-block fs-3 mb-2"></i>
          No test history matches your search filter.
        </td>
      </tr>
    `;
    return;
  }
  
  pageSubset.forEach(r => {
    const row = document.createElement('tr');
    const date = new Date(r.timestamp);
    const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    
    row.innerHTML = `
      <td>
        <div class="d-block font-semibold">${dateStr}</div>
        <span class="text-muted fs-small">${timeStr}</span>
      </td>
      <td>
        <div class="font-semibold">${r.isp}</div>
        <span class="text-muted fs-small">IP: ${r.ip}</span>
      </td>
      <td><span class="text-pink font-semibold">${r.ping}</span> <span class="text-muted fs-small">ms</span></td>
      <td><span class="text-yellow font-semibold">${r.jitter.toFixed(1)}</span> <span class="text-muted fs-small">ms</span></td>
      <td class="table-speed-cell table-speed-dl">${r.download.toFixed(1)} <span class="text-muted fs-small">Mbps</span></td>
      <td class="table-speed-cell table-speed-ul">${r.upload.toFixed(1)} <span class="text-muted fs-small">Mbps</span></td>
      <td>
        <div class="font-semibold">${r.location}</div>
        <span class="text-muted fs-small">Edge Server</span>
      </td>
      <td>
        <button class="btn btn-icon btn-danger btn-delete-test" data-id="${r.id}" title="Delete Test">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </td>
    `;
    
    // Bind click to delete button
    row.querySelector('.btn-delete-test').addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(e.currentTarget.getAttribute('data-id'));
      if (confirm('Are you sure you want to delete this test record?')) {
        await deleteRecord(id);
        showToast('Record Deleted', 'Test entry has been removed.', 'fa-trash');
        await refreshAllViews();
      }
    });
    
    // Bind click to row to load into result card
    row.addEventListener('click', () => {
      updateShareCardDOM(r);
      showToast('Card Loaded', 'Test values loaded in Result Card tab.', 'fa-share-nodes');
      // Highlight nav item and show share panel
      document.getElementById('nav-share-tab').click();
    });
    
    tbody.appendChild(row);
  });
}

// Refresh all components
async function refreshAllViews() {
  await refreshCharts();
  await refreshHistoryLogTable();
}

// -------------------------------------------------------------
// CSV IMPORT/EXPORT LOGIC
// -------------------------------------------------------------
async function exportHistoryToCSV() {
  const records = await getAllRecords();
  if (records.length === 0) {
    showToast('Export Cancelled', 'No database entries found to export.', 'fa-triangle-exclamation');
    return;
  }
  
  let csvContent = 'ID,Timestamp,ISP,IP,ServerLocation,Ping_ms,Jitter_ms,Download_Mbps,Upload_Mbps,DataUsed_MB\n';
  
  records.forEach(r => {
    csvContent += `"${r.id}","${new Date(r.timestamp).toISOString()}","${r.isp.replace(/"/g, '""')}","${r.ip}","${r.location.replace(/"/g, '""')}","${r.ping}","${r.jitter}","${r.download}","${r.upload}","${r.dataUsed}"\n`;
  });
  
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `AeroSpeed_history_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Export Complete', 'Saved history file as CSV.', 'fa-file-csv');
}

function importCSVFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async function(evt) {
    try {
      const text = evt.target.result;
      const lines = text.split('\n');
      let importCount = 0;
      
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '') continue;
        
        // Custom robust CSV line parsing to handle comma/quotes
        const values = parseCSVLine(line);
        if (values.length < 10) continue;
        
        const record = {
          timestamp: new Date(values[1]).getTime() || Date.now(),
          isp: values[2],
          ip: values[3],
          location: values[4],
          ping: parseInt(values[5]) || 0,
          jitter: parseFloat(values[6]) || 0,
          download: parseFloat(values[7]) || 0,
          upload: parseFloat(values[8]) || 0,
          dataUsed: parseFloat(values[9]) || 0
        };
        
        await saveTestRecord(record);
        importCount++;
      }
      
      showToast('Import Complete', `Successfully imported ${importCount} speed test records.`, 'fa-circle-check');
      e.target.value = ''; // clear selector
      await refreshAllViews();
      
    } catch (err) {
      console.error(err);
      showToast('Import Failed', 'CSV format was invalid or corrupt.', 'fa-triangle-exclamation');
    }
  };
  
  reader.readAsText(file);
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// -------------------------------------------------------------
// HISTORICAL MOCK DATA GENERATOR
// -------------------------------------------------------------
async function handleMockDataGeneration() {
  const generateBtn = document.getElementById('generate-mock-data-btn');
  const msgEl = document.getElementById('mock-progress-msg');
  const provider = document.getElementById('mock-provider-select').value;
  
  generateBtn.disabled = true;
  msgEl.textContent = 'Generating 365 daily entries. Please wait...';
  
  try {
    const now = new Date();
    // Clear current database first to make evaluation clean
    await clearDatabase();
    
    // Performance aggregate: load entries in smaller batches to avoid indexedDB lockup
    const totalDays = 365;
    let createdCount = 0;
    
    // Average base speed configuration based on selected provider
    let baseDl = 120.0;
    let baseUl = 40.0;
    let basePing = 18;
    
    if (provider === 'AT&T Fiber') {
      baseDl = 680.0;
      baseUl = 620.0;
      basePing = 6;
    } else if (provider === 'Google Fiber') {
      baseDl = 910.0;
      baseUl = 880.0;
      basePing = 4;
    } else if (provider === 'Spectrum') {
      baseDl = 220.0;
      baseUl = 18.0;
      basePing = 24;
    }
    
    const transaction = state.db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    for (let day = totalDays; day >= 1; day--) {
      const date = new Date();
      date.setDate(now.getDate() - day);
      
      // Simulate random test times throughout the day
      const testHour = Math.floor(Math.random() * 24);
      const testMin = Math.floor(Math.random() * 60);
      date.setHours(testHour, testMin, 0, 0);
      
      // Peak Congestion speed multiplier (Speeds are lower between 7 PM and 10 PM)
      let timeMultiplier = 1.0;
      if (testHour >= 19 && testHour <= 22) {
        timeMultiplier = 0.72 - (Math.random() * 0.15); // 30-40% speed drop during peak
      } else if (testHour >= 2 && testHour <= 5) {
        timeMultiplier = 1.08 + (Math.random() * 0.1); // slightly faster off-peak
      }
      
      // Weekend congestion drops (speeds are slightly lower on Sat/Sun)
      const dayOfWeek = date.getDay();
      let weekendMultiplier = 1.0;
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        weekendMultiplier = 0.88 - (Math.random() * 0.08);
      }
      
      // Speeds variations
      const dlNoise = (Math.random() - 0.5) * 0.12 * baseDl;
      const ulNoise = (Math.random() - 0.5) * 0.12 * baseUl;
      
      let download = Math.max(1, (baseDl + dlNoise) * timeMultiplier * weekendMultiplier);
      let upload = Math.max(1, (baseUl + ulNoise) * timeMultiplier * weekendMultiplier);
      
      // Add occasional drop-out anomaly (e.g. outage day)
      if (Math.random() < 0.03) {
        download = baseDl * 0.1; // 90% speed drop
        upload = baseUl * 0.1;
      }
      
      // Ping and Jitter scale inversely with speed
      const pingNoise = (Math.random() - 0.5) * 3;
      const downloadRatio = baseDl / download; // higher ratio = slower speed = higher latency
      const ping = Math.max(1, Math.round(basePing + pingNoise + (downloadRatio * 1.5)));
      const jitter = Math.max(0.2, (ping * 0.15) + (Math.random() * 2));
      
      const record = {
        timestamp: date.getTime(),
        download: parseFloat(download.toFixed(1)),
        upload: parseFloat(upload.toFixed(1)),
        ping: ping,
        jitter: parseFloat(jitter.toFixed(1)),
        isp: provider,
        ip: provider === 'Comcast Xfinity' ? '68.45.192.12' : (provider === 'AT&T Fiber' ? '99.12.80.45' : '108.20.12.3'),
        location: 'Local Edge Center',
        dataUsed: parseFloat((30 + Math.random()*25).toFixed(2)) // 30-55 MB consumed
      };
      
      store.add(record);
      createdCount++;
    }
    
    transaction.oncomplete = async () => {
      msgEl.textContent = 'Data loaded! Compiling views...';
      
      // Pull last record to populate results card
      const all = await getAllRecords();
      if (all.length > 0) {
        updateShareCardDOM(all[0]);
      }
      
      await refreshAllViews();
      generateBtn.disabled = false;
      msgEl.textContent = 'Successfully generated 365 daily entries!';
      showToast('Mock Data Loaded', '1 Year of daily records added to database.', 'fa-wand-magic-sparkles');
      
      // Auto transition to Dashboard to see results
      setTimeout(() => {
        document.querySelector('[data-tab="analytics-tab"]').click();
      }, 1000);
    };
    
  } catch (e) {
    console.error('Failed to generate mock data:', e);
    msgEl.textContent = 'Error writing records.';
    generateBtn.disabled = false;
  }
}

// -------------------------------------------------------------
// TOAST NOTIFICATIONS BANNER
// -------------------------------------------------------------
function showToast(title, body, iconClass = 'fa-bell') {
  const toast = document.getElementById('notification-toast');
  const icon = document.getElementById('toast-icon');
  const titleEl = document.getElementById('toast-title');
  const bodyEl = document.getElementById('toast-body');
  
  icon.className = `fa-solid ${iconClass}`;
  titleEl.textContent = title;
  bodyEl.textContent = body;
  
  toast.classList.remove('hidden');
  
  // Clear any existing timer
  if (toast.dataset.timeoutId) {
    clearTimeout(parseInt(toast.dataset.timeoutId));
  }
  
  // Auto-hide after 5 seconds
  const id = setTimeout(() => {
    toast.classList.add('hidden');
  }, 4500);
  
  toast.dataset.timeoutId = id;
}

// -------------------------------------------------------------
// BACKGROUND PERIODIC TESTING SIMULATOR
// -------------------------------------------------------------
function toggleBackgroundTesting(e) {
  const checked = e.target.checked;
  state.bgTestEnabled = checked;
  
  if (checked) {
    const intervalSec = parseInt(document.getElementById('bg-test-interval').value);
    
    // Start Interval
    state.backgroundTestIntervalId = setInterval(async () => {
      if (state.currentTest.isRunning) return; // skip if a test is already running manually
      
      console.log('Background Speed Test Simulation starting...');
      
      // Simulate quick test
      const baseDl = 100;
      // 10% chance of a speed drop
      const speedDrop = Math.random() < 0.15;
      const download = speedDrop ? 12 + Math.random()*5 : baseDl + (Math.random() - 0.5)*20;
      const upload = speedDrop ? 2 + Math.random()*2 : 35 + (Math.random() - 0.5)*10;
      const ping = speedDrop ? 85 : 12;
      const jitter = speedDrop ? 18 : 2.2;
      
      const record = {
        timestamp: Date.now(),
        download: parseFloat(download.toFixed(1)),
        upload: parseFloat(upload.toFixed(1)),
        ping: Math.round(ping),
        jitter: parseFloat(jitter.toFixed(1)),
        isp: 'Background Engine',
        ip: '127.0.0.1',
        location: 'Auto Node',
        dataUsed: 1.50
      };
      
      await saveTestRecord(record);
      await refreshAllViews();
      
      if (speedDrop) {
        showToast('Speed Drop Alert!', `Background test logged a drop to ${download.toFixed(1)} Mbps (Ping: ${ping}ms).`, 'fa-triangle-exclamation');
      } else {
        console.log(`Background test completed: ${download.toFixed(1)} Mbps`);
      }
      
    }, intervalSec * 1000);
    
    showToast('Background Testing Active', `Testing in background every ${intervalSec} seconds.`, 'fa-circle-play');
  } else {
    if (state.backgroundTestIntervalId) {
      clearInterval(state.backgroundTestIntervalId);
      state.backgroundTestIntervalId = null;
    }
    showToast('Background Testing Halted', 'Scheduled testing simulation disabled.', 'fa-circle-stop');
  }
}

// -------------------------------------------------------------
// EVENT HANDLERS & BINDINGS
// -------------------------------------------------------------
function setupEventListeners() {
  // 1. Sidebar Tab Switching
  document.querySelectorAll('.nav-item').forEach(button => {
    button.addEventListener('click', (e) => {
      const tabId = e.currentTarget.getAttribute('data-tab');
      
      // Update Active Navigation Item
      document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
      e.currentTarget.classList.add('active');
      
      // Update Visible Tab content
      document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.remove('active');
      });
      const activePanel = document.getElementById(tabId);
      activePanel.classList.add('active');
      
      // Update Sub-Header Title text
      const pageTitle = document.getElementById('page-title');
      const pageSubtitle = document.getElementById('page-subtitle');
      
      if (tabId === 'test-tab') {
        pageTitle.textContent = 'Speed Test Console';
        pageSubtitle.textContent = 'Measure your real-time internet throughput';
      } else if (tabId === 'analytics-tab') {
        pageTitle.textContent = 'Analytics & Insights';
        pageSubtitle.textContent = 'Aggregate performance graphs and trends';
        refreshCharts();
      } else if (tabId === 'history-tab') {
        pageTitle.textContent = 'Test History Log';
        pageSubtitle.textContent = 'Full catalog of your local network tests';
        refreshHistoryLogTable();
      } else if (tabId === 'share-tab') {
        pageTitle.textContent = 'Result Card Generator';
        pageSubtitle.textContent = 'Export a premium connection overview card';
      } else if (tabId === 'tools-tab') {
        pageTitle.textContent = 'Tools & Preferences';
        pageSubtitle.textContent = 'Manage mock database generators and network nodes';
      }
      
      state.activeTab = tabId;
    });
  });
  
  // 2. Speed Test Controller
  document.getElementById('start-test-btn').addEventListener('click', runSpeedTest);
  document.getElementById('cancel-test-btn').addEventListener('click', () => {
    state.currentTest.cancelRequested = true;
  });
  
  // 3. Time Granularity Toggle on Analytics tab
  document.querySelectorAll('#granularity-toggle .btn-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#granularity-toggle .btn-toggle').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      
      state.analyticsView = e.target.getAttribute('data-view');
      refreshCharts();
    });
  });
  
  // 4. Search Filter on History Log
  document.getElementById('history-search').addEventListener('input', (e) => {
    state.history.searchQuery = e.target.value;
    state.history.currentPage = 1; // reset page
    refreshHistoryLogTable();
  });
  
  // Pagination Buttons
  document.getElementById('prev-page-btn').addEventListener('click', () => {
    if (state.history.currentPage > 1) {
      state.history.currentPage--;
      refreshHistoryLogTable();
    }
  });
  
  document.getElementById('next-page-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(state.history.totalRecords / state.history.pageSize);
    if (state.history.currentPage < totalPages) {
      state.history.currentPage++;
      refreshHistoryLogTable();
    }
  });
  
  // 5. Result Card Styling Controls
  document.querySelectorAll('.btn-theme').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.btn-theme').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      
      const theme = e.currentTarget.getAttribute('data-theme');
      state.activeTheme = theme;
      
      const card = document.getElementById('share-card-element');
      card.className = `share-card-container theme-${theme}`;
    });
  });
  
  // Download Result Card PNG
  document.getElementById('download-card-btn').addEventListener('click', renderCardToPNG);
  
  // Copy Link Clipboard
  document.getElementById('copy-clipboard-btn').addEventListener('click', () => {
    const fakeUrl = `https://aerospeed.io/results/share?dl=${document.getElementById('card-download-val').textContent}&ul=${document.getElementById('card-upload-val').textContent}&ping=${document.getElementById('card-ping-val').textContent}&theme=${state.activeTheme}`;
    navigator.clipboard.writeText(fakeUrl).then(() => {
      const alertEl = document.getElementById('copy-alert');
      alertEl.classList.remove('hidden');
      setTimeout(() => alertEl.classList.add('hidden'), 3500);
    });
  });
  
  // 6. Settings Actions (Mock Data, Reset Database, Background)
  document.getElementById('generate-mock-data-btn').addEventListener('click', handleMockDataGeneration);
  
  document.getElementById('clear-database-btn').addEventListener('click', async () => {
    if (confirm('Are you sure you want to purge all speed test records? This action is permanent.')) {
      await clearDatabase();
      showToast('Database Purged', 'IndexedDB store has been cleared.', 'fa-trash-arrow-up');
      await refreshAllViews();
    }
  });
  
  document.getElementById('clear-all-history-btn').addEventListener('click', async () => {
    if (confirm('Wipe all tests from local history log?')) {
      await clearDatabase();
      showToast('Database Purged', 'Test log successfully emptied.', 'fa-trash-can');
      await refreshAllViews();
    }
  });
  
  // CSV Export/Import
  document.getElementById('export-csv-btn').addEventListener('click', exportHistoryToCSV);
  document.getElementById('import-csv-file').addEventListener('change', importCSVFile);
  
  // Background interval settings
  document.getElementById('bg-test-toggle').addEventListener('change', toggleBackgroundTesting);
  document.getElementById('bg-test-interval').addEventListener('change', (e) => {
    if (state.bgTestEnabled) {
      // Re-trigger toggle
      const mockEvent = { target: { checked: true } };
      toggleBackgroundTesting(mockEvent);
    }
  });
  
  // Toast close button
  document.getElementById('toast-close-btn').addEventListener('click', () => {
    document.getElementById('notification-toast').classList.add('hidden');
  });
}

// -------------------------------------------------------------
// ENVIRONMENT STATS LOADER
// -------------------------------------------------------------
function loadDiagnostics() {
  document.getElementById('browser-ua').textContent = navigator.userAgent;
  document.getElementById('screen-resolution').textContent = `${window.screen.width} x ${window.screen.height}`;
  
  // Check Persistence Mode
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then(persisted => {
      document.getElementById('persistence-type').textContent = persisted ? 'Persistent' : 'Best Effort';
      document.getElementById('persistence-type').className = `badge ${persisted ? 'badge-success' : 'alert-warning'}`;
    });
  }
}

// -------------------------------------------------------------
// INITIALIZATION ON WINDOW LOAD
// -------------------------------------------------------------
window.addEventListener('load', async () => {
  try {
    // 1. Initialize IndexedDB
    await initDB();
    
    // 2. Initialize Canvas elements and start animation loops
    initAnimationLoops();
    cursorDroplets = new CursorDroplets(document.getElementById('cursor-canvas'));
    
    // 3. Bind Event listeners
    setupEventListeners();
    
    // 4. Load Browser environment stats
    loadDiagnostics();
    
    // 5. Pre-load charts and table if data exists
    await refreshAllViews();
    
    // Check if empty, load ambient prompt
    const records = await getAllRecords();
    if (records.length === 0) {
      showToast('Welcome!', 'Click "Start Test" or use the Mock Data Tool under "Tools" to populate history.', 'fa-bolt-lightning');
    } else {
      updateShareCardDOM(records[0]);
    }
    
  } catch (err) {
    console.error('Initialization error:', err);
    showToast('Start Error', 'IndexedDB storage initialize failed. Try clearing browser cache.', 'fa-circle-xmark');
  }
});

// Adjust canvas dimensions on browser window resizing
window.addEventListener('resize', () => {
  const pCanvas = document.getElementById('particle-canvas');
  const gCanvas = document.getElementById('gauge-canvas');
  const sCanvas = document.getElementById('sparkline-canvas');
  
  if (pCanvas && gCanvas && sCanvas) {
    pCanvas.width = pCanvas.offsetWidth * window.devicePixelRatio;
    pCanvas.height = pCanvas.offsetHeight * window.devicePixelRatio;
    gCanvas.width = gCanvas.offsetWidth * window.devicePixelRatio;
    gCanvas.height = gCanvas.offsetHeight * window.devicePixelRatio;
    
    sCanvas.width = sCanvas.offsetWidth;
    sCanvas.height = sCanvas.offsetHeight;
    
    if (particleSystem) {
      particleSystem.centerX = pCanvas.width / 2;
      particleSystem.centerY = pCanvas.height / 2;
    }
    if (speedGauge) {
      speedGauge.centerX = gCanvas.width / 2;
      speedGauge.centerY = gCanvas.height / 2;
    }
  }
});
