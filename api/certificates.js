// Vercel serverless function: owner-only certificate upload.
// Needs three environment variables in the Vercel project settings:
//   ADMIN_PASSWORD  the password only you know
//   GITHUB_TOKEN    a fine-grained token with "Contents: Read and write" on this repo only
//   GITHUB_REPO     owner/name, e.g. marvindiss/MyDigitalPortfolio
// Optional: GITHUB_BRANCH (defaults to main)

const crypto = require('crypto');

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function passwordOk(given) {
  const real = process.env.ADMIN_PASSWORD;
  if (!real || typeof given !== 'string') return false;
  return crypto.timingSafeEqual(sha(given), sha(real));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function clean(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function slug(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'certificate';
}

async function gh(path, options) {
  const repo = process.env.GITHUB_REPO;
  const res = await fetch('https://api.github.com/repos/' + repo + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'portfolio-upload',
      'Content-Type': 'application/json'
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.message) || 'GitHub error ' + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST.' });
  }

  if (!process.env.ADMIN_PASSWORD || !process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: 'The upload is not set up yet. Add ADMIN_PASSWORD, GITHUB_TOKEN and GITHUB_REPO in Vercel, then redeploy.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!passwordOk(body.password)) {
    await wait(1000); // slows down guessing
    return res.status(401).json({ error: 'Wrong password.' });
  }

  if (body.action === 'check') {
    return res.status(200).json({ ok: true });
  }

  if (body.action !== 'add') {
    return res.status(400).json({ error: 'Unknown action.' });
  }

  // ---- validate the new certificate ----
  const e = body.entry || {};
  const entry = {
    date: clean(e.date, 10),
    topic: clean(e.topic, 30),
    title: clean(e.title, 160),
    organizer: clean(e.organizer, 120),
    hours: Number(e.hours),
    format: clean(e.format, 80) || 'Online webinar',
    signers: clean(e.signers, 200),
    idLabel: clean(e.idLabel, 40) || 'Credential ID',
    idValue: clean(e.idValue, 120)
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || isNaN(Date.parse(entry.date))) {
    return res.status(400).json({ error: 'Enter a valid date.' });
  }
  if (!entry.title || !entry.organizer || !entry.topic) {
    return res.status(400).json({ error: 'Title, organizer and topic are required.' });
  }
  if (!(entry.hours > 0 && entry.hours <= 100)) {
    return res.status(400).json({ error: 'Hours must be a number between 0 and 100.' });
  }

  const b64 = typeof body.image === 'string' ? body.image.replace(/^data:image\/jpeg;base64,/, '') : '';
  const imgBuf = Buffer.from(b64, 'base64');
  // JPEG files start with FF D8 FF
  if (imgBuf.length < 1000 || imgBuf[0] !== 0xff || imgBuf[1] !== 0xd8 || imgBuf[2] !== 0xff) {
    return res.status(400).json({ error: 'The certificate image is missing or is not a JPEG.' });
  }
  if (imgBuf.length > MAX_IMAGE_BYTES) {
    return res.status(400).json({ error: 'The image is too large. Try a smaller one.' });
  }

  const id = slug(entry.title) + '-' + entry.date.slice(2).replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex');
  entry.id = id;
  entry.image = 'assets/cert-' + id + '.jpg';

  const branch = process.env.GITHUB_BRANCH || 'main';

  try {
    // 1. read the current list
    const file = await gh('/contents/certificates.json?ref=' + encodeURIComponent(branch), { method: 'GET' });
    const list = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    if (!Array.isArray(list)) throw new Error('certificates.json is not a list.');

    // 2. save the image
    await gh('/contents/' + entry.image, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'Add certificate image: ' + entry.title,
        content: imgBuf.toString('base64'),
        branch
      })
    });

    // 3. save the updated list
    list.push(entry);
    await gh('/contents/certificates.json', {
      method: 'PUT',
      body: JSON.stringify({
        message: 'Add certificate: ' + entry.title,
        content: Buffer.from(JSON.stringify(list, null, 2) + '\n', 'utf8').toString('base64'),
        sha: file.sha,
        branch
      })
    });

    return res.status(200).json({ ok: true, entry });
  } catch (err) {
    const hint = err.status === 401 || err.status === 403 || err.status === 404
      ? ' Check that GITHUB_TOKEN can write to ' + process.env.GITHUB_REPO + '.'
      : '';
    return res.status(502).json({ error: 'Could not save to GitHub: ' + err.message + '.' + hint });
  }
};
