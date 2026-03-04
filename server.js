require('dotenv').config();
const express = require('express');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 4000;

const DATA_FILE = path.join(__dirname, 'data', 'products.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

function readProducts() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8') || '[]');
}

function writeProducts(products) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(products, null, 2));
}

function generateCode(gender, products) {
  const prefix = 'AG';
  const nums = products
    .filter(p => p.code && p.code.startsWith(prefix))
    .map(p => parseInt(p.code.replace(/^AG-/, ''), 10))
    .filter(n => !isNaN(n));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

// Migrate old products (single image -> media array)
function migrateProduct(p) {
  if (!p.media) {
    p.media = [];
    if (p.image) {
      p.media.push({ path: p.image, type: 'image', isCover: true });
      delete p.image;
    }
  }
  return p;
}

function getCover(product) {
  if (!product.media || product.media.length === 0) return null;
  const cover = product.media.find(m => m.isCover);
  return cover || product.media[0];
}

// --- Multer ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `media-${Date.now()}-${Math.random().toString(36).substring(2, 6)}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.webm'];
  const ext = path.extname(file.originalname).toLowerCase();
  cb(null, allowed.includes(ext));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB for videos
});

// --- Admin credentials ---
const ADMIN_USER = 'admin';
const ADMIN_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ag-catalogo-secret-default',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 horas
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

function ensureAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autorizado' });
  res.redirect('/login');
}

// --- Auth routes ---
app.get('/login', (req, res) => {
  if (req.session && req.session.admin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && bcrypt.compareSync(password || '', ADMIN_HASH)) {
    req.session.admin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// --- API ---

// GET all products
app.get('/api/products', (req, res) => {
  let products = readProducts().map(migrateProduct);
  if (req.query.gender) {
    products = products.filter(p => p.gender === req.query.gender || p.gender === 'unisex');
  }
  products.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
  res.json(products);
});

// GET single
app.get('/api/products/:id', (req, res) => {
  const products = readProducts().map(migrateProduct);
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'No encontrado' });
  res.json(product);
});

// POST create product (multiple files)
app.post('/api/products', ensureAuth, upload.array('media', 15), (req, res) => {
  const products = readProducts().map(migrateProduct);
  const { name, price, description, category, material, color, fit, sizes, tag, coverIndex } = req.body;
  let gender = req.body.gender;

  if (!name || !price) {
    return res.status(400).json({ error: 'Nombre y precio son obligatorios' });
  }

  // Accessories are always unisex
  if (category === 'accesorio') {
    gender = 'unisex';
  } else if (!gender) {
    return res.status(400).json({ error: 'El género es obligatorio para esta categoría' });
  }

  const coverIdx = parseInt(coverIndex) || 0;
  const media = (req.files || []).map((file, i) => {
    const ext = path.extname(file.filename).toLowerCase();
    const isVideo = ['.mp4', '.mov', '.webm'].includes(ext);
    return {
      path: `/uploads/${file.filename}`,
      type: isVideo ? 'video' : 'image',
      isCover: i === coverIdx
    };
  });

  // Ensure at least one cover
  if (media.length > 0 && !media.some(m => m.isCover)) {
    media[0].isCover = true;
  }

  const product = {
    id: `prod-${Date.now()}`,
    code: generateCode(gender, products),
    name: name.substring(0, 32),
    price,
    description: description || '',
    gender,
    category: category || 'remeras-camisas',
    material: material || '',
    color: color || '',
    fit: fit || '',
    sizes: sizes ? (typeof sizes === 'string' ? JSON.parse(sizes) : sizes) : { S: true, M: true, L: true, XL: true, XXL: true },
    tag: tag || '',
    media,
    createdAt: new Date().toISOString()
  };

  products.push(product);
  writeProducts(products);
  res.status(201).json(product);
});

// PUT update product fields (without replacing media)
app.put('/api/products/:id', ensureAuth, upload.array('media', 15), (req, res) => {
  const products = readProducts().map(migrateProduct);
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });

  const { name, price, description, category, material, color, fit, sizes, tag, coverIndex, existingMedia } = req.body;
  let gender = req.body.gender;

  if (name) products[idx].name = name.substring(0, 32);
  if (price) products[idx].price = price;
  if (description !== undefined) products[idx].description = description;
  if (category) {
    products[idx].category = category;
    if (category === 'accesorio') {
      products[idx].gender = 'unisex';
    } else if (gender) {
      products[idx].gender = gender;
    }
  } else if (gender) {
    products[idx].gender = gender;
  }
  if (material !== undefined) products[idx].material = material;
  if (color !== undefined) products[idx].color = color;
  if (fit !== undefined) products[idx].fit = fit;
  if (sizes) products[idx].sizes = typeof sizes === 'string' ? JSON.parse(sizes) : sizes;
  if (tag !== undefined) products[idx].tag = tag;

  // Rebuild media array: keep existing + add new
  let kept = [];
  if (existingMedia) {
    const parsed = typeof existingMedia === 'string' ? JSON.parse(existingMedia) : existingMedia;
    kept = Array.isArray(parsed) ? parsed : [];
  }

  // Delete removed files
  const keptPaths = new Set(kept.map(m => m.path));
  for (const old of (products[idx].media || [])) {
    if (!keptPaths.has(old.path)) {
      const filePath = path.join(__dirname, old.path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }

  // Add new uploads
  const newMedia = (req.files || []).map(file => {
    const ext = path.extname(file.filename).toLowerCase();
    const isVideo = ['.mp4', '.mov', '.webm'].includes(ext);
    return { path: `/uploads/${file.filename}`, type: isVideo ? 'video' : 'image', isCover: false };
  });

  const allMedia = [...kept, ...newMedia];

  // Set cover
  const cIdx = parseInt(coverIndex);
  allMedia.forEach((m, i) => { m.isCover = (i === cIdx); });
  if (allMedia.length > 0 && !allMedia.some(m => m.isCover)) {
    allMedia[0].isCover = true;
  }

  products[idx].media = allMedia;
  writeProducts(products);
  res.json(products[idx]);
});

// DELETE product
app.delete('/api/products/:id', ensureAuth, (req, res) => {
  let products = readProducts().map(migrateProduct);
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'No encontrado' });

  for (const m of (product.media || [])) {
    const filePath = path.join(__dirname, m.path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  products = products.filter(p => p.id !== req.params.id);
  writeProducts(products);
  res.json({ success: true });
});

// --- Pages ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', ensureAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/catalogo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalogo.html')));
app.get('/catalogo/:gender', (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalogo.html')));

app.listen(PORT, () => {
  console.log(`\n  AG - ROPA IMPORTADA | Catálogo Digital`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Portal:     http://localhost:${PORT}`);
  console.log(`  Admin:      http://localhost:${PORT}/admin`);
  console.log(`  Catálogo H: http://localhost:${PORT}/catalogo/hombre`);
  console.log(`  Catálogo M: http://localhost:${PORT}/catalogo/mujer`);
  console.log(`  ─────────────────────────────────────\n`);
});
