require('dotenv').config();
const express = require('express');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const cloudinary = require('cloudinary').v2;
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

// --- Cloudinary ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// --- Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function generateCode() {
  const prefix = 'AG';
  const { data } = await supabase
    .from('products')
    .select('code')
    .like('code', 'AG-%');
  const nums = (data || [])
    .map(p => parseInt(p.code.replace(/^AG-/, ''), 10))
    .filter(n => !isNaN(n));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

// --- Multer (memory storage for Cloudinary) ---
const fileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.webm'];
  const ext = path.extname(file.originalname).toLowerCase();
  cb(null, allowed.includes(ext));
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Upload buffer to Cloudinary
function uploadToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isVideo = ['.mp4', '.mov', '.webm'].includes(ext);
    const resourceType = isVideo ? 'video' : 'image';

    const stream = cloudinary.uploader.upload_stream(
      { folder: 'ag-catalogo', resource_type: resourceType },
      (error, result) => {
        if (error) return reject(error);
        resolve({ url: result.secure_url, publicId: result.public_id, type: resourceType });
      }
    );
    stream.end(file.buffer);
  });
}

// Delete from Cloudinary
function deleteFromCloudinary(publicId, resourceType) {
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType || 'image' });
}

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

// No cache for API routes (prevents Vercel/browser caching)
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

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
app.get('/api/products', async (req, res) => {
  try {
    let query = supabase.from('products').select('*').order('code');
    if (req.query.gender) {
      query = query.or(`gender.eq.${req.query.gender},gender.eq.unisex`);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

// GET single
app.get('/api/products/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'No encontrado' });
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: 'No encontrado' });
  }
});

// POST create product
app.post('/api/products', ensureAuth, upload.array('media', 15), async (req, res) => {
  try {
    const { name, price, currency, description, category, sizes, tag, coverIndex } = req.body;
    let gender = req.body.gender;

    if (!name || !price) {
      return res.status(400).json({ error: 'Nombre y precio son obligatorios' });
    }

    if (category === 'accesorio') {
      gender = 'unisex';
    } else if (!gender) {
      return res.status(400).json({ error: 'El género es obligatorio para esta categoría' });
    }

    const coverIdx = parseInt(coverIndex) || 0;

    // Upload files to Cloudinary
    const uploads = await Promise.all((req.files || []).map(f => uploadToCloudinary(f)));
    const media = uploads.map((u, i) => ({
      path: u.url,
      publicId: u.publicId,
      type: u.type,
      isCover: i === coverIdx
    }));

    if (media.length > 0 && !media.some(m => m.isCover)) {
      media[0].isCover = true;
    }

    const code = await generateCode();
    const product = {
      id: `prod-${Date.now()}`,
      code,
      name: name.substring(0, 32),
      price,
      currency: currency || 'USD',
      description: description || '',
      gender,
      category: category || 'remeras-camisas',
      sizes: sizes ? (typeof sizes === 'string' ? JSON.parse(sizes) : sizes) : { S: true, M: true, L: true, XL: true, XXL: true },
      tag: tag || '',
      media,
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase.from('products').insert(product).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('Error creating product:', err);
    res.status(500).json({ error: 'Error al crear producto' });
  }
});

// PUT update product
app.put('/api/products/:id', ensureAuth, upload.array('media', 15), async (req, res) => {
  try {
    // Get current product
    const { data: current, error: fetchErr } = await supabase
      .from('products')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (fetchErr || !current) return res.status(404).json({ error: 'No encontrado' });

    const { name, price, currency, description, category, sizes, tag, coverIndex, existingMedia } = req.body;
    let gender = req.body.gender;

    const updates = {};
    if (name) updates.name = name.substring(0, 32);
    if (price) updates.price = price;
    if (currency) updates.currency = currency;
    if (description !== undefined) updates.description = description;
    if (category) {
      updates.category = category;
      if (category === 'accesorio') {
        updates.gender = 'unisex';
      } else if (gender) {
        updates.gender = gender;
      }
    } else if (gender) {
      updates.gender = gender;
    }
    if (sizes) updates.sizes = typeof sizes === 'string' ? JSON.parse(sizes) : sizes;
    if (tag !== undefined) updates.tag = tag;

    // Rebuild media array
    let kept = [];
    if (existingMedia) {
      const parsed = typeof existingMedia === 'string' ? JSON.parse(existingMedia) : existingMedia;
      kept = Array.isArray(parsed) ? parsed : [];
    }

    // Delete removed files from Cloudinary
    const keptPaths = new Set(kept.map(m => m.path));
    for (const old of (current.media || [])) {
      if (!keptPaths.has(old.path) && old.publicId) {
        await deleteFromCloudinary(old.publicId, old.type === 'video' ? 'video' : 'image');
      }
    }

    // Upload new files to Cloudinary
    const uploadResults = await Promise.all((req.files || []).map(f => uploadToCloudinary(f)));
    const newMedia = uploadResults.map(u => ({
      path: u.url, publicId: u.publicId, type: u.type, isCover: false
    }));

    const allMedia = [...kept, ...newMedia];
    const cIdx = parseInt(coverIndex);
    allMedia.forEach((m, i) => { m.isCover = (i === cIdx); });
    if (allMedia.length > 0 && !allMedia.some(m => m.isCover)) {
      allMedia[0].isCover = true;
    }
    updates.media = allMedia;

    const { data, error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error updating product:', err);
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
});

// DELETE product
app.delete('/api/products/:id', ensureAuth, async (req, res) => {
  try {
    const { data: product, error: fetchErr } = await supabase
      .from('products')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (fetchErr || !product) return res.status(404).json({ error: 'No encontrado' });

    // Delete media from Cloudinary
    for (const m of (product.media || [])) {
      if (m.publicId) {
        await deleteFromCloudinary(m.publicId, m.type === 'video' ? 'video' : 'image');
      }
    }

    const { error } = await supabase.from('products').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting product:', err);
    res.status(500).json({ error: 'Error al eliminar producto' });
  }
});

// --- Pages ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', ensureAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/catalogo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalogo.html')));
app.get('/catalogo/:gender', (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalogo.html')));

// Local dev
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n  AG - ROPA IMPORTADA | Catálogo Digital`);
    console.log(`  ─────────────────────────────────────`);
    console.log(`  Portal:     http://localhost:${PORT}`);
    console.log(`  Admin:      http://localhost:${PORT}/admin`);
    console.log(`  Catálogo H: http://localhost:${PORT}/catalogo/hombre`);
    console.log(`  Catálogo M: http://localhost:${PORT}/catalogo/mujer`);
    console.log(`  ─────────────────────────────────────\n`);
  });
}

module.exports = app;
