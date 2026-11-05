#!/usr/bin/env node
/**
 * organize-downloads.js (updated)
 *
 * - Loads config from ~/.quick-actions/config.json if configHelper.js is present.
 * - Uses configurable: targetFolder, backupFolder (for logs), rules, recursive, autoYes, previewLimit
 * - Default: dry-run
 * - Flags: --dry-run (default), --execute, --yes, --undo, --target <path>
 *
 * No external dependencies.
 */

const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = os.homedir();
const FALLBACK_DOWNLOADS = path.join(HOME, 'Downloads');

// -------------------------
// Load config (if available)
// -------------------------
const CONFIG_HELPER_PATH = path.join(__dirname, 'configHelper.js');

let CONFIG = null;

// default fallback config (if configHelper isn't present)
const FALLBACK_CONFIG = {
  targetFolder: FALLBACK_DOWNLOADS,
  backupFolder: path.join(HOME, '.quick-actions', 'backup'),
  rules: {
    ".jpg": "Images",
    ".jpeg": "Images",
    ".png": "Images",
    ".gif": "Images",
    ".webp": "Images",
    ".pdf": "Documents",
    ".doc": "Documents",
    ".docx": "Documents",
    ".txt": "Text",
    ".csv": "Data",
    ".zip": "Archives",
    ".rar": "Archives",
    ".7z": "Archives",
    ".gz": "Archives",
    ".mp4": "Videos",
    ".mkv": "Videos",
    ".mp3": "Audio"
  },
  recursive: false,
  autoYes: false,
  previewLimit: 200
};

async function loadConfig() {
  try {
    if (fssync.existsSync(CONFIG_HELPER_PATH)) {
      const cfgMod = require(CONFIG_HELPER_PATH);
      // prefer async read if available
      if (cfgMod && typeof cfgMod.readConfig === 'function') {
        const cfg = await cfgMod.readConfig();
        CONFIG = Object.assign({}, cfgMod.DEFAULT_PREFS || FALLBACK_CONFIG, cfg || {});
        return;
      }
    }
  } catch (e) {
    // ignore and fallback
    console.warn('Config helper read error, using fallback config:', e.message || e);
  }
  CONFIG = FALLBACK_CONFIG;
}

// -------------------------
// CLI parsing
// -------------------------
const argv = process.argv.slice(2);
const args = {
  dryRun: true,
  execute: false,
  undo: false,
  yes: false,
  target: null
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--execute') args.execute = true;
  else if (a === '--dry-run') args.dryRun = true;
  else if (a === '--undo') args.undo = true;
  else if (a === '--yes' || a === '--force') args.yes = true;
  else if (a === '--target') args.target = path.resolve(argv[++i]);
  else if (a === '--help' || a === '-h') args.help = true;
  else if (a === '--verbose') args.verbose = true;
}

if (args.execute) args.dryRun = false;

if (args.help) {
  console.log(`
organize-downloads.js [--target <folder>] [--dry-run] [--execute] [--yes] [--undo] [--verbose]

--target <folder>  Directory to organize (default: configured target, usually ~/Downloads)
--dry-run          Show planned moves only (default if neither --execute nor --undo passed)
--execute          Perform the moves (writes op log)
--yes              Skip interactive confirmation (or rely on config autoYes)
--undo             Undo the last execute operation (reads last op log)
--verbose          Show more info
--help / -h        Show this help
`);
  process.exit(0);
}

// -------------------------
// Utilities
// -------------------------
async function ensureDir(p) {
  try { await fs.mkdir(p, { recursive: true }); } catch (e) { /* ignore */ }
}

async function statSafe(p) {
  try { return await fs.stat(p); } catch (e) { return null; }
}

// list files at top-level or recursively based on `recursive` flag
async function listFiles(dir, recursive = false) {
  const results = [];
  async function walk(current) {
    let items;
    try { items = await fs.readdir(current, { withFileTypes: true }); }
    catch (err) { return; }
    for (const it of items) {
      const full = path.join(current, it.name);
      if (it.isDirectory()) {
        if (full.includes(path.join(HOME, '.quick-actions'))) continue; // avoid internal folder
        if (recursive) await walk(full);
      } else if (it.isFile()) {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

async function getUniqueTargetPath(destDir, name) {
  const base = path.parse(name).name;
  const ext = path.parse(name).ext;
  let candidate = name;
  let i = 1;
  while (true) {
    const full = path.join(destDir, candidate);
    try {
      await fs.access(full);
      candidate = `${base} (${i})${ext}`;
      i++;
    } catch (err) {
      return path.join(destDir, candidate);
    }
  }
}

// -------------------------
// Plan & execute
// -------------------------
function planMoves(files, rules, targetBase) {
  const moves = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const rule = rules[ext] || null;
    if (!rule) continue;
    const targetDir = path.join(targetBase, rule);
    const baseName = path.basename(f);
    const targetPath = path.join(targetDir, baseName);
    moves.push({ from: f, toDir: targetDir, toName: baseName, to: targetPath, ext, rule });
  }
  return moves;
}

function printDryRunLabeled(files, plan, previewLimit = 200) {
  if (plan.length === 0) {
    console.log('Nothing to move.');
    return;
  }
  // MOVE lines
  for (const p of plan) {
    console.log(`MOVE: ${p.from} -> ${p.to}`);
  }
  // SKIP lines (files that were not included in plan)
  const movingSet = new Set(plan.map(p => p.from));
  const skipped = files.filter(f => !movingSet.has(f));
  for (const s of skipped.slice(0, previewLimit)) {
    console.log(`SKIP: ${s}`);
  }
  if (skipped.length > previewLimit) {
    console.log(`SKIP: ... and ${skipped.length - previewLimit} more skipped files`);
  }
}

// execute moves and write op log to ops dir (in configured backupFolder)
async function executeMoves(moves, opsDir, verbose = false) {
  await ensureDir(opsDir);
  const opId = crypto.randomBytes(6).toString('hex');
  const opLog = { id: opId, timestamp: new Date().toISOString(), moves: [] };

  for (const m of moves) {
    try {
      await ensureDir(m.toDir);
      let finalTarget;
      try { await fs.access(m.to); finalTarget = await getUniqueTargetPath(m.toDir, m.toName); }
      catch (e) { finalTarget = m.to; }
      await fs.rename(m.from, finalTarget);
      opLog.moves.push({ from: m.from, to: finalTarget });
      if (verbose) console.log('Moved', m.from, '->', finalTarget);
    } catch (err) {
      opLog.moves.push({ from: m.from, to: null, error: err.message });
      if (verbose) console.error('Error moving', m.from, err.message);
    }
  }

  const logName = `${opLog.timestamp.replace(/[:.]/g,'-')}_${opLog.id}.json`;
  const logPath = path.join(opsDir, logName);
  await fs.writeFile(logPath, JSON.stringify(opLog, null, 2), 'utf8');
  return logPath;
}

// -------------------------
// Undo last op (reads ops dir)
async function undoLastOperation(opsDir) {
  await ensureDir(opsDir);
  const files = fssync.readdirSync(opsDir).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log('No operation logs found to undo.');
    return;
  }
  const last = files[files.length - 1];
  const full = path.join(opsDir, last);
  const txt = fssync.readFileSync(full, 'utf8');
  let op;
  try { op = JSON.parse(txt); } catch (e) { console.error('Failed to read op log', e); return; }

  console.log('Undoing operation from', op.timestamp, 'id', op.id);
  for (const mv of op.moves.reverse()) {
    if (!mv.to) {
      console.log('Skipping entry (failed originally):', mv.from);
      continue;
    }
    try {
      await fs.access(mv.to);
    } catch (err) {
      console.log('Target missing, skipping restore:', mv.to);
      continue;
    }
    const origDir = path.dirname(mv.from);
    await ensureDir(origDir);
    let finalOrig = mv.from;
    try {
      await fs.access(mv.from);
      // original exists; create unique restore name
      const name = path.parse(mv.from).name;
      const ext = path.parse(mv.from).ext;
      let i = 1;
      let candidate;
      do {
        candidate = path.join(origDir, `${name} (restored ${i})${ext}`);
        try { await fs.access(candidate); i++; } catch(e){ break; }
      } while (true);
      finalOrig = candidate;
    } catch (err) {
      // original does not exist -> ok
    }
    try {
      await fs.rename(mv.to, finalOrig);
      console.log('Restored', mv.to, '->', finalOrig);
    } catch (e) {
      console.log('Failed to restore', mv.to, e.message);
    }
  }

  // mark log as undone
  const undonePath = full.replace('.json', '.undone.json');
  fssync.renameSync(full, undonePath);
  console.log('Undo complete. Log moved to', undonePath);
}

// -------------------------
// Main flow
// -------------------------
(async () => {
  await loadConfig();
  const OPS_DIR = path.join(CONFIG.backupFolder || path.join(HOME, '.quick-actions', 'backup'), 'ops');

  if (args.undo) {
    await undoLastOperation(OPS_DIR);
    return;
  }

  const target = args.target ? path.resolve(args.target) : (CONFIG.targetFolder || FALLBACK_DOWNLOADS);
  const rules = CONFIG.rules || {};
  const recursive = !!CONFIG.recursive;
  const previewLimit = Number(CONFIG.previewLimit || 200);
  const autoYes = !!CONFIG.autoYes;

  // ensure target exists
  const st = await statSafe(target);
  if (!st || !st.isDirectory()) {
    console.error('Target folder does not exist or is not a directory:', target);
    process.exit(1);
  }

  // list files (top-level or recursive)
  const files = await listFiles(target, recursive);

  // plan moves
  const moves = planMoves(files, rules, target);

  if (args.dryRun) {
    printDryRunLabeled(files, moves, previewLimit);
    return;
  }

  // execute path
  if (args.execute) {
    if (!args.yes && !autoYes) {
      console.log(`About to move ${moves.length} files. Use --yes or enable autoYes in preferences to skip this prompt.`);
      process.exit(1);
    }
    // perform moves
    await ensureDir(path.join(CONFIG.backupFolder || path.join(HOME, '.quick-actions', 'backup')));
    const logPath = await executeMoves(moves, OPS_DIR, args.verbose);
    console.log('Done. Log:', logPath);
    return;
  }

})();
