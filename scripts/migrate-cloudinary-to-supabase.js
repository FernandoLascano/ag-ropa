// Migrate Cloudinary-hosted media to Supabase Storage.
//
// Reads every product from Supabase, downloads each Cloudinary URL,
// optimizes images via sharp, uploads to the `media` bucket, and updates
// the product record. Idempotent: items already on Supabase Storage
// (with a `storagePath` field) are skipped.
//
// Run: node scripts/migrate-cloudinary-to-supabase.js
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.

require('dotenv').config();
const crypto = require('crypto');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'media';
const MAX_WIDTH = 1200;
const JPEG_QUALITY = 82;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function downloadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function migrateMediaItem(m) {
  if (m.storagePath) return { item: m, migrated: false, skipped: 'already on Supabase' };
  if (!m.path || !m.path.includes('cloudinary')) return { item: m, migrated: false, skipped: 'not Cloudinary' };

  let buffer = await downloadBuffer(m.path);
  const isVideo = m.type === 'video';
  let ext, contentType;

  if (isVideo) {
    const urlExt = (m.path.split('.').pop() || 'mp4').toLowerCase().split('?')[0];
    ext = ['mp4', 'mov', 'webm'].includes(urlExt) ? urlExt : 'mp4';
    contentType = `video/${ext === 'mov' ? 'quicktime' : ext}`;
  } else {
    const img = sharp(buffer, { animated: false }).rotate();
    const meta = await img.metadata();
    let pipeline = img;
    if (meta.width && meta.width > MAX_WIDTH) {
      pipeline = pipeline.resize({ width: MAX_WIDTH, withoutEnlargement: true });
    }
    buffer = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
    ext = 'jpg';
    contentType = 'image/jpeg';
  }

  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const storagePath = `products/${filename}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType, upsert: false });
  if (upErr) throw upErr;

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

  return {
    item: {
      path: pub.publicUrl,
      storagePath,
      type: m.type,
      isCover: !!m.isCover
    },
    migrated: true
  };
}

async function migrateProduct(product) {
  const newMedia = [];
  let changed = false;
  let failed = 0;

  for (const m of (product.media || [])) {
    try {
      const result = await migrateMediaItem(m);
      newMedia.push(result.item);
      if (result.migrated) changed = true;
    } catch (e) {
      console.error(`    ✗ ${m.path}: ${e.message}`);
      newMedia.push(m); // keep old reference; can retry later
      failed++;
    }
  }

  if (changed) {
    const { error } = await supabase.from('products').update({ media: newMedia }).eq('id', product.id);
    if (error) throw error;
  }
  return { changed, failed };
}

async function main() {
  const { data, error } = await supabase
    .from('products')
    .select('id, code, name, media')
    .order('code');
  if (error) throw error;

  console.log(`Productos: ${data.length}`);
  let migratedCount = 0, failedCount = 0;

  for (const p of data) {
    const total = (p.media || []).length;
    const pending = (p.media || []).filter(m => !m.storagePath && m.path && m.path.includes('cloudinary')).length;
    if (pending === 0) {
      console.log(`SKIP ${p.code} — ${p.name} (sin items Cloudinary)`);
      continue;
    }
    console.log(`\n→ ${p.code} — ${p.name}  (${pending}/${total} a migrar)`);
    try {
      const { changed, failed } = await migrateProduct(p);
      if (changed) migratedCount++;
      failedCount += failed;
    } catch (e) {
      console.error(`  Error producto ${p.code}: ${e.message}`);
      failedCount++;
    }
  }

  console.log(`\n────────────`);
  console.log(`Productos actualizados: ${migratedCount}`);
  console.log(`Items fallidos:         ${failedCount}`);
  console.log(`Si quedan fallos, volvé a correr el script (es idempotente).`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
