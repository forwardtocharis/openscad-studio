// OpenSCAD Studio - local web GUI for AI-assisted OpenSCAD projects (agy / Claude Code).
// Zero runtime deps besides `three` (served locally for the viewer).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = __dirname;
const PROJECTS = path.join(ROOT, 'projects');
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const PORT = +process.env.PORT || 3333;
const HOST = '127.0.0.1';
fs.mkdirSync(PROJECTS, { recursive: true });

// ---------- config ----------
const DEFAULT_CONFIG = {
  openscad: '',            // auto-detected if empty
  claude: '',              // auto-detected if empty
  agy: '',                 // auto-detected if empty (~/.gemini/bin/agy.exe)
  claudeModels: ['sonnet', 'opus', 'haiku'],
  claudePermissionMode: 'acceptEdits',
  agyMode: 'accept-edits',
  agyAllow: ['command(openscad)', 'command(openscad.exe)', 'command(openscad.com)', 'command(mkdir)'],  // permission rules for headless agy
  agyExtraArgs: [],        // e.g. ['--dangerously-skip-permissions']
  agentTimeoutMin: 20,
};
const loadConfig = () => {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_CONFIG }; }
};

function findOpenscad(cfg) {
  const cands = [cfg.openscad,
    'C:\\Program Files\\OpenSCAD\\openscad.exe', 'C:\\Program Files\\OpenSCAD (Nightly)\\openscad.exe',
    'C:\\Program Files (x86)\\OpenSCAD\\openscad.exe', 'openscad'].filter(Boolean);
  return cands.find(c => !c.includes('\\') || fs.existsSync(c)) || 'openscad';
}
function findAgy(cfg) {
  if (cfg.agy) return cfg.agy;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const p = path.join(home, '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  return fs.existsSync(p) ? p : 'agy';
}
function findClaude(cfg) {
  if (cfg.claude) return cfg.claude;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  // The VS Code-style extension ships a native binary; versions change, so glob for it.
  for (const extDir of [path.join(home, '.antigravity-ide', 'extensions'), path.join(home, '.vscode', 'extensions')]) {
    try {
      const dirs = fs.readdirSync(extDir).filter(d => d.startsWith('anthropic.claude-code')).sort().reverse();
      for (const d of dirs) {
        const p = path.join(extDir, d, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (fs.existsSync(p)) return p;
      }
    } catch {}
  }
  return 'claude';
}

// ---------- helpers ----------
const slugOk = s => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
const pdir = slug => path.join(PROJECTS, slug);
const metaPath = slug => path.join(pdir(slug), 'project.json');
const readMeta = slug => JSON.parse(fs.readFileSync(metaPath(slug), 'utf8'));
const writeMeta = (slug, m) => fs.writeFileSync(metaPath(slug), JSON.stringify(m, null, 2));
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = req => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) { no(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } });
});

const AGENT_INSTRUCTIONS = `# OpenSCAD project (for 3D printing)

You are working in a single OpenSCAD project directory. The main model is \`main.scad\`.

Rules:
- Edit \`main.scad\` (you may add helper .scad files in this directory). Do not touch files outside this directory.
- Expose dimensions as named parameters at the top of the file with comments (Customizer-friendly).
- Design for FDM 3D printing: units are mm, avoid unsupported overhangs > 45 deg where possible, minimum wall >= 1.2 mm,
  add tolerances (~0.2 mm) for mating parts, orient the model flat on the XY plane with its base at z=0, use $fn >= 64 for round parts.
- The GUI re-renders automatically after you finish and shows any errors. If you can run shell commands, also verify it renders: \`openscad -o renders/model.stl main.scad\` (create the renders/ folder if missing)
  and fix any errors or warnings. The GUI previews renders/model.stl.
- \`versions/\` holds read-only snapshots of earlier iterations (versions/NNN/main.scad, model.stl, version.json; see versions/INDEX.md).
  Never edit them. Only look at them if the user asks you to build on, compare with or revert to an earlier version.
- Keep \`NOTES.md\` updated with a short description, key dimensions and print settings (layer height, infill, supports).
- Reply briefly: what you changed and any print advice.
`;

const projectInfo = slug => {
  const m = readMeta(slug);
  const stl = path.join(pdir(slug), 'renders', 'model.stl');
  const scad = path.join(pdir(slug), 'main.scad');
  return { slug, ...m,
    hasStl: fs.existsSync(stl),
    stlTime: fs.existsSync(stl) ? fs.statSync(stl).mtimeMs : null,
    scadTime: fs.existsSync(scad) ? fs.statSync(scad).mtimeMs : null };
};
const listProjects = () => fs.readdirSync(PROJECTS).filter(s => slugOk(s) && fs.existsSync(metaPath(s)))
  .map(projectInfo).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
const touch = slug => { const m = readMeta(slug); m.updated = new Date().toISOString(); writeMeta(slug, m); };

// ---------- rendering ----------
function render(slug) {
  return new Promise(resolve => {
    const dir = pdir(slug);
    fs.mkdirSync(path.join(dir, 'renders'), { recursive: true });
    const out = path.join('renders', 'model.stl');
    execFile(findOpenscad(loadConfig()), ['-o', out, 'main.scad'], { cwd: dir, timeout: 300000, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, log: (stdout || '') + (stderr || '') + (err && !stderr ? String(err) : '') }));
  });
}

// ---------- versions (snapshots) ----------
const vdir = slug => path.join(pdir(slug), 'versions');
const vnum = n => String(n).padStart(3, '0');
const scadFiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.scad')).sort() : [];
function listVersions(slug) {
  const d = vdir(slug);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(x => /^\d+$/.test(x)).sort().map(x => {
    try { return { ...JSON.parse(fs.readFileSync(path.join(d, x, 'version.json'), 'utf8')), hasStl: fs.existsSync(path.join(d, x, 'model.stl')) }; } catch { return null; }
  }).filter(Boolean);
}
const sameScad = (a, b) => { const fa = scadFiles(a), fb = scadFiles(b);
  return fa.join() === fb.join() && fa.every(f => fs.readFileSync(path.join(a, f), 'utf8') === fs.readFileSync(path.join(b, f), 'utf8')); };
function writeIndex(slug) {
  const vs = listVersions(slug);
  const lines = ['# Version history (read-only snapshots)', '', 'Each folder has main.scad (+ helper .scad files), model.stl and version.json.', ''];
  for (const v of vs) lines.push(`- versions/${vnum(v.n)}/ - ${v.time} - ${v.source}${v.backend ? ' (' + v.backend + (v.model ? ' ' + v.model : '') + ')' : ''}: ${(v.prompt || v.note || '').replace(/\s+/g, ' ').slice(0, 160)}`);
  fs.writeFileSync(path.join(vdir(slug), 'INDEX.md'), lines.join('\n') + '\n');
}
// Snapshot current *.scad + renders/model.stl. Skips if unchanged since last snapshot (unless force).
function snapshot(slug, info = {}, force = false) {
  const dir = pdir(slug), vs = listVersions(slug), last = vs[vs.length - 1];
  if (!force && last && sameScad(dir, path.join(vdir(slug), vnum(last.n)))) return null;
  const n = (last ? last.n : 0) + 1, d = path.join(vdir(slug), vnum(n));
  fs.mkdirSync(d, { recursive: true });
  for (const f of scadFiles(dir)) fs.copyFileSync(path.join(dir, f), path.join(d, f));
  const stl = path.join(dir, 'renders', 'model.stl');
  if (fs.existsSync(stl)) fs.copyFileSync(stl, path.join(d, 'model.stl'));
  fs.writeFileSync(path.join(d, 'version.json'), JSON.stringify({ n, time: new Date().toISOString(), source: 'manual', ...info }, null, 2));
  writeIndex(slug);
  return n;
}

// ---------- models ----------
let agyModelCache = null;
function agyModels() {
  if (agyModelCache) return Promise.resolve(agyModelCache);
  return new Promise(resolve => {
    const cfg = loadConfig();
    execFile(findAgy(cfg), ['models'], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      const txt = (stdout || '') + '\n' + (stderr || '');
      const models = txt.split(/\r?\n/).map(l => l.split('\t')).filter(p => p.length >= 2 && /^[\w.\-]+$/.test(p[0]))
        .map(([id, name]) => ({ id, name: name.trim() }));
      if (models.length) agyModelCache = models;
      resolve(models);
    });
  });
}

// ---------- agent runs ----------
const runs = new Map(); // slug -> { child, log: [], clients:Set, done }
function emit(run, event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  run.log.push(line);
  for (const c of run.clients) c.write(line);
}
function startAgent(slug, { backend, model, prompt, resume, versionRef }) {
  const cfg = loadConfig();
  const dir = pdir(slug);
  const run = { log: [], clients: new Set(), done: false, backend, model, started: Date.now(), reply: '' };
  let cmd, args, opts = { cwd: dir, windowsHide: true, env: { ...process.env } };
  const osc = findOpenscad(cfg);
  if (osc.includes(path.sep)) opts.env.PATH = path.dirname(osc) + path.delimiter + (opts.env.PATH || opts.env.Path || '');
  if (backend === 'claude') {
    cmd = findClaude(cfg);
    args = ['-p', prompt, '--permission-mode', cfg.claudePermissionMode,
      '--allowedTools', 'Bash(openscad:*)', 'Edit', 'Write', 'Read', 'Glob', 'Grep'];
    if (model) args.push('--model', model);
    if (resume) args.push('--continue');
  } else {
    cmd = findAgy(cfg);
    args = ['-p', prompt, '--mode', cfg.agyMode, '--settings', JSON.stringify({ permissions: { allow: cfg.agyAllow } }), ...cfg.agyExtraArgs];
    if (model) args.push('--model', model);
    if (resume) args.push('--continue');
  }
  emit(run, 'info', `$ ${backend} ${model ? '--model ' + model : ''} (cwd: projects/${slug})\n`);
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  run.child = child;
  const timer = setTimeout(() => { emit(run, 'info', '\n[timeout - killing agent]\n'); child.kill(); }, cfg.agentTimeoutMin * 60000);
  child.stdout.on('data', d => { run.reply = (run.reply + d.toString()).slice(-4000); emit(run, 'out', d.toString()); });
  child.stderr.on('data', d => emit(run, 'err', d.toString()));
  child.on('error', e => emit(run, 'err', `Failed to start: ${e.message}\n`));
  child.on('close', async code => {
    clearTimeout(timer);
    emit(run, 'info', `\n[agent exited: ${code}] rendering...\n`);
    const r = await render(slug);
    emit(run, 'info', r.ok ? '[render ok]\n' : '[render failed]\n' + r.log + '\n');
    const vn = snapshot(slug, { source: 'agent', backend, model, prompt, reply: run.reply.trim(), basedOn: versionRef || undefined, renderOk: r.ok });
    if (vn) emit(run, 'info', `[saved as version ${vnum(vn)}]\n`);
    touch(slug);
    run.done = true;
    emit(run, 'done', { code, renderOk: r.ok });
    for (const c of run.clients) c.end();
    run.clients.clear();
  });
  runs.set(slug, run);
  return run;
}

// ---------- routing ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.stl': 'model/stl', '.svg': 'image/svg+xml' };
function serveFile(res, file, root) {
  const full = path.resolve(file);
  if (!full.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    // Block DNS-rebinding / cross-site requests: only accept localhost hosts and same-origin.
    const host = (req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host)) return send(res, 403, { error: 'bad host' });
    if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'bad origin' });

    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    const m = p.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);

    if (p === '/api/config' && req.method === 'GET') {
      const cfg = loadConfig();
      return send(res, 200, { openscad: findOpenscad(cfg), claude: findClaude(cfg), claudeModels: cfg.claudeModels, agyModels: await agyModels() });
    }
    if (p === '/api/health') {
      const cfg = loadConfig();
      return send(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), openscadFound: findOpenscad(cfg).includes(path.sep) ? fs.existsSync(findOpenscad(cfg)) : null,
        running: [...runs].filter(([, r]) => !r.done).map(([s, r]) => ({ slug: s, backend: r.backend, model: r.model, sec: Math.round((Date.now() - r.started) / 1000) })) });
    }
    if (p === '/api/projects' && req.method === 'GET') return send(res, 200, listProjects());
    if (p === '/api/projects' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim();
      if (!name) return send(res, 400, { error: 'name required' });
      let slug = slugify(name), i = 2;
      while (fs.existsSync(pdir(slug))) slug = slugify(name) + '-' + i++;
      fs.mkdirSync(path.join(pdir(slug), 'renders'), { recursive: true });
      const now = new Date().toISOString();
      writeMeta(slug, { name, description: String(b.description || ''), status: 'idea', tags: [], backend: b.backend === 'agy' ? 'agy' : 'claude', model: b.model || '', created: now, updated: now, history: [], conv: 1 });
      fs.writeFileSync(path.join(pdir(slug), 'main.scad'), `// ${name}\n// Units: mm\n\nsize = 20; // [5:100]\n$fn = 64;\n\ncube(size, center = false);\n`);
      fs.writeFileSync(path.join(pdir(slug), 'CLAUDE.md'), AGENT_INSTRUCTIONS);
      fs.writeFileSync(path.join(pdir(slug), 'AGENTS.md'), AGENT_INSTRUCTIONS);
      fs.writeFileSync(path.join(pdir(slug), 'NOTES.md'), `# ${name}\n\n${b.description || ''}\n`);
      render(slug).then(() => snapshot(slug, { source: 'initial', note: 'Starter file' }, true));
      return send(res, 201, projectInfo(slug));
    }
    if (m) {
      const slug = m[1], sub = m[2] || '';
      if (!slugOk(slug) || !fs.existsSync(metaPath(slug))) return send(res, 404, { error: 'no such project' });
      if (sub === '' && req.method === 'GET') return send(res, 200, projectInfo(slug));
      if (sub === '' && req.method === 'PATCH') {
        const b = await readBody(req), meta = readMeta(slug);
        for (const k of ['name', 'description', 'status', 'backend', 'model']) if (typeof b[k] === 'string') meta[k] = b[k];
        if (Array.isArray(b.tags)) meta.tags = b.tags.map(String).slice(0, 20);
        writeMeta(slug, meta);
        return send(res, 200, projectInfo(slug));
      }
      if (sub === '' && req.method === 'DELETE') {
        if (runs.get(slug) && !runs.get(slug).done) return send(res, 409, { error: 'agent running' });
        fs.rmSync(pdir(slug), { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }
      if (sub === 'scad' && req.method === 'GET') return send(res, 200, fs.readFileSync(path.join(pdir(slug), 'main.scad'), 'utf8'), 'text/plain');
      if (sub === 'scad' && req.method === 'PUT') {
        const b = await readBody(req);
        fs.writeFileSync(path.join(pdir(slug), 'main.scad'), String(b.code ?? ''));
        touch(slug);
        return send(res, 200, { ok: true });
      }
      if (sub === 'notes' && req.method === 'GET') {
        const f = path.join(pdir(slug), 'NOTES.md');
        return send(res, 200, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', 'text/plain');
      }
      if (sub === 'render' && req.method === 'POST') { const r = await render(slug); const v = snapshot(slug, { source: 'manual', note: 'Edited in GUI', renderOk: r.ok }); touch(slug); return send(res, 200, { ...r, version: v }); }
      if (sub === 'new-conversation' && req.method === 'POST') {
        const meta = readMeta(slug); meta.conv = (meta.conv || 1) + 1; writeMeta(slug, meta);
        return send(res, 200, { conv: meta.conv });
      }
      if (sub === 'versions' && req.method === 'GET') return send(res, 200, listVersions(slug));
      const vm = sub.match(/^versions\/(\d+)\/(model\.stl|main\.scad|version\.json|restore)$/);
      if (vm) {
        const n = +vm[1], d = path.join(vdir(slug), vnum(n));
        if (!fs.existsSync(d)) return send(res, 404, { error: 'no such version' });
        if (vm[2] === 'restore' && req.method === 'POST') {
          if (runs.get(slug) && !runs.get(slug).done) return send(res, 409, { error: 'agent running' });
          snapshot(slug, { source: 'pre-restore', note: 'Auto-saved before restoring version ' + vnum(n) });
          for (const f of scadFiles(pdir(slug))) fs.rmSync(path.join(pdir(slug), f));
          for (const f of scadFiles(d)) fs.copyFileSync(path.join(d, f), path.join(pdir(slug), f));
          const r = await render(slug);
          const v = snapshot(slug, { source: 'restore', note: 'Restored from version ' + vnum(n), renderOk: r.ok }, true);
          touch(slug);
          return send(res, 200, { ...r, version: v });
        }
        if (req.method === 'GET' && vm[2] === 'main.scad') return send(res, 200, fs.readFileSync(path.join(d, 'main.scad'), 'utf8'), 'text/plain');
        if (req.method === 'GET') return serveFile(res, path.join(d, vm[2]), pdir(slug));
      }
      if (sub === 'model.stl') return serveFile(res, path.join(pdir(slug), 'renders', 'model.stl'), pdir(slug));
      if (sub === 'agent' && req.method === 'POST') {
        const b = await readBody(req);
        if (runs.get(slug) && !runs.get(slug).done) return send(res, 409, { error: 'agent already running' });
        if (!b.prompt || typeof b.prompt !== 'string') return send(res, 400, { error: 'prompt required' });
        const backend = b.backend === 'agy' ? 'agy' : 'claude';
        const model = typeof b.model === 'string' && /^[\w.\-:\[\]]*$/.test(b.model) ? b.model : '';
        const meta = readMeta(slug);
        const conv = meta.conv || 1;
        const resume = !b.fresh && !!(meta.history && meta.history.some(h => h.backend === backend && (h.conv || 1) === conv));
        let prompt = b.prompt;
        const ref = Number.isInteger(b.versionRef) ? b.versionRef : null;
        if (ref !== null) {
          if (!listVersions(slug).some(v => v.n === ref)) return send(res, 400, { error: 'no such version' });
          prompt += `\n\n(Reference: an earlier iteration of this model is in versions/${vnum(ref)}/main.scad with its render in versions/${vnum(ref)}/model.stl. Read it as needed, but make your changes in main.scad in the project root.)`;
        }
        meta.backend = backend; meta.model = model;
        meta.history = [...(meta.history || []), { time: new Date().toISOString(), backend, model, prompt: b.prompt, conv }].slice(-200);
        writeMeta(slug, meta);
        startAgent(slug, { backend, model, prompt, resume, versionRef: ref });
        return send(res, 202, { ok: true });
      }
      if (sub === 'agent/stream' && req.method === 'GET') {
        const run = runs.get(slug);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        if (!run) { res.write('event: done\ndata: {}\n\n'); return res.end(); }
        if (run.done) { res.write('event: done\ndata: {}\n\n'); return res.end(); }
        res.write(run.log.join(''));
        run.clients.add(res);
        req.on('close', () => run.clients.delete(res));
        return;
      }
      if (sub === 'agent/stop' && req.method === 'POST') {
        const run = runs.get(slug);
        if (run && !run.done) run.child.kill();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'unknown endpoint' });
    }

    if (p.startsWith('/vendor/three/')) return serveFile(res, path.join(ROOT, 'node_modules', 'three', p.slice('/vendor/three/'.length)), path.join(ROOT, 'node_modules', 'three'));
    return serveFile(res, path.join(PUBLIC, p === '/' ? 'index.html' : p), PUBLIC);
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});
// Backfill: snapshot existing projects once, and teach their agent files about versions/.
for (const slug of listProjects().map(p => p.slug)) {
  try {
    if (!listVersions(slug).length) snapshot(slug, { source: 'baseline', note: 'Existing state when versioning was added' }, true);
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const fp = path.join(pdir(slug), f);
      if (fs.existsSync(fp) && !fs.readFileSync(fp, 'utf8').includes('versions/')) fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').trimEnd() + '\n- `versions/` holds read-only snapshots of earlier iterations (see versions/INDEX.md). Never edit them; only consult them if the user asks.\n');
    }
  } catch (e) { console.error('backfill failed for', slug, e.message); }
}
server.listen(PORT, HOST, () => console.log(`OpenSCAD Studio: http://localhost:${PORT}`));
