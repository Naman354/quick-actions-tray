// main.js (HTML preview window + execute-from-preview) - merged & fixed
// Safe loader for configHelper (works even if file doesn't exist)
const fsSync = require('fs');
let readConfig = async () => {
  // fallback defaults (kept in sync with organizer)
  const HOME = require('os').homedir();
  return {
    targetFolder: require('path').join(HOME, 'Downloads'),
    backupFolder: require('path').join(HOME, '.quick-actions', 'backup'),
    rules: {
      ".jpg": "Images", ".jpeg":"Images", ".png":"Images", ".gif":"Images", ".webp":"Images",
      ".pdf":"Documents", ".doc":"Documents", ".docx":"Documents", ".txt":"Text", ".csv":"Data",
      ".zip":"Archives", ".rar":"Archives", ".7z":"Archives", ".gz":"Archives",
      ".mp4":"Videos", ".mkv":"Videos", ".mp3":"Audio"
    },
    recursive: false,
    autoYes: false,
    previewLimit: 200,
    enableHotkey: true
  };
};
let writeConfig = async (obj) => {
  // fallback writer creates config.json so Preferences can persist
  const cfgPath = require('path').join(require('os').homedir(), '.quick-actions', 'config.json');
  try {
    await require('fs').promises.mkdir(require('path').join(require('os').homedir(), '.quick-actions'), { recursive: true });
    await require('fs').promises.writeFile(cfgPath, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('writeConfig fallback failed:', e);
    throw e;
  }
};
try {
  if (fsSync.existsSync(require('path').join(__dirname, 'configHelper.js'))) {
    const cfg = require('./configHelper');
    if (cfg && typeof cfg.readConfig === 'function') readConfig = cfg.readConfig;
    if (cfg && typeof cfg.writeConfig === 'function') writeConfig = cfg.writeConfig;
  }
} catch (e) {
  console.warn('Could not load configHelper; falling back to internal read/write.', e.message || e);
}

const { app, Tray, Menu, Notification, dialog, nativeImage, shell, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');

console.log('main.js loaded (HTML preview)');

let tray = null;
const OPS_DIR = path.join(os.homedir(), '.quick-actions', 'backup', 'ops');
const SCRIPT = path.join(__dirname, 'organize-downloads.js');
let previewWindow = null;

// run organizer script
function runOrganizer(args = [], callback = () => {}) {
  const nodeCmd = (() => {
    if (process.platform === 'win32') return 'node';
    return process.execPath || 'node';
  })();

  try {
    const child = spawn(nodeCmd, [SCRIPT, ...args], { env: process.env });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      console.error('Failed to start child process:', err);
      dialog.showErrorBox('Execution error', String(err));
      callback(1, '', String(err));
    });

    child.on('close', (code) => {
      if (stderr) console.error('Organizer stderr:', stderr);
      callback(code, stdout.trim(), stderr.trim());
    });
  } catch (err) {
    console.error('runOrganizer exception:', err);
    dialog.showErrorBox('runOrganizer error', String(err));
    callback(1, '', String(err));
  }
}

function notify(title, body) {
  try { new Notification({ title, body }).show(); } catch (e) { console.log('Notification error', e); }
}

function openOpsDir() {
  try {
    if (!fs.existsSync(OPS_DIR)) fs.mkdirSync(OPS_DIR, { recursive: true });
    shell.openPath(OPS_DIR);
  } catch (err) {
    dialog.showErrorBox('Error', 'Could not open ops directory: ' + err.message);
  }
}

// Build HTML for preview: grouped categories + skipped + raw-output toggle
function buildPreviewHTML(grouped, skipped, rawOutput, previewLimitUI = Infinity) {
  // simple inline CSS for table
  const css = `
    body { font-family: system-ui, sans-serif; margin: 12px; color: #222; }
    h1 { font-size: 18px; margin-bottom: 6px; }
    .summary { margin-bottom: 12px; }
    .category { margin-bottom: 10px; }
    .cat-title { font-weight: 600; margin-bottom: 6px; }
    ul.files { margin-top: 0; margin-bottom: 6px; padding-left: 20px; }
    table { border-collapse: collapse; width: 100%; max-width: 900px; margin-bottom: 12px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; }
    .controls { margin-top: 12px; display:flex; gap:8px; }
    button { padding: 8px 12px; font-size: 13px; cursor: pointer; }
    pre { background: #fafafa; border: 1px solid #eee; padding: 8px; max-height: 300px; overflow: auto; }
    .small { font-size: 12px; color: #555; }
  `;

  // build categories HTML (apply previewLimitUI per category if set)
  let catsHtml = '';
  const keys = Object.keys(grouped).sort();
  if (keys.length === 0 && skipped.length === 0) {
    catsHtml = `<div class="small">No planned moves found.</div>`;
  } else {
    for (const k of keys) {
      const list = grouped[k];
      const displayList = list.slice(0, previewLimitUI);
      catsHtml += `<div class="category"><div class="cat-title">${escapeHtml(k)} — ${list.length} file${list.length>1?'s':''}</div><ul class="files">`;
      for (const f of displayList) {
        catsHtml += `<li>${escapeHtml(f)}</li>`;
      }
      if (list.length > previewLimitUI) catsHtml += `<li>... and ${list.length - previewLimitUI} more</li>`;
      catsHtml += `</ul></div>`;
    }
    if (skipped && skipped.length > 0) {
      const skipDisplay = skipped.slice(0, previewLimitUI);
      catsHtml += `<div class="category"><div class="cat-title">Files that will NOT move (${skipped.length})</div><ul class="files">`;
      for (const s of skipDisplay) {
        catsHtml += `<li>${escapeHtml(s)}</li>`;
      }
      if (skipped.length > previewLimitUI) catsHtml += `<li>... and ${skipped.length - previewLimitUI} more</li>`;
      catsHtml += `</ul></div>`;
    }
  }

  // raw output area
  const rawHtml = `<details><summary>Show raw preview output</summary><pre>${escapeHtml(rawOutput || '')}</pre></details>`;

  // final HTML with buttons that call ipcRenderer
  const html = `
    <!doctype html>
    <html>
    <head><meta charset="utf-8"><title>Quick Actions — Preview</title><style>${css}</style></head>
    <body>
      <h1>Organize — Preview</h1>
      <div class="summary small">Review the categories below. Click <strong>Execute</strong> to apply changes, or <strong>Close</strong> to cancel.</div>
      <div id="categories">${catsHtml}</div>
      ${rawHtml}
      <div class="controls">
        <button id="executeBtn">Execute</button>
        <button id="fullListBtn">Show full list</button>
        <button id="closeBtn">Close</button>
      </div>
      <div id="status" class="small" style="margin-top:8px"></div>

      <script>
        const { ipcRenderer } = require('electron');
        const executeBtn = document.getElementById('executeBtn');
        const fullListBtn = document.getElementById('fullListBtn');
        const closeBtn = document.getElementById('closeBtn');
        const status = document.getElementById('status');

        executeBtn.addEventListener('click', () => {
          status.textContent = 'Executing...';
          executeBtn.disabled = true;
          ipcRenderer.send('execute-from-preview');
        });

        fullListBtn.addEventListener('click', () => {
          ipcRenderer.send('show-full-preview');
        });

        closeBtn.addEventListener('click', () => {
          window.close();
        });

        // receive execution finished message
        ipcRenderer.on('execute-done', (event, ok, message) => {
          status.textContent = message || (ok ? 'Done' : 'Failed');
          executeBtn.disabled = false;
        });
      </script>
    </body>
    </html>
  `;
  return html;
}

// simple HTML escape
function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// open preview window with given HTML content
function openPreviewWindow(html) {
  // if already open, focus and update content
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.webContents.executeJavaScript('document.documentElement.innerHTML = ' + JSON.stringify(html));
    previewWindow.focus();
    return;
  }

  previewWindow = new BrowserWindow({
    width: 820,
    height: 640,
    resizable: true,
    webPreferences: {
      nodeIntegration: true, // enable ipcRenderer in the preview (local-only)
      contextIsolation: false
    },
    title: 'Quick Actions — Preview'
  });

  // load via data URL
  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  previewWindow.loadURL(dataUrl);

  previewWindow.on('closed', () => { previewWindow = null; });
}

// Listen for execute from preview window
ipcMain.on('execute-from-preview', (ev) => {
  // run organizer and report back when done
  notify('Quick Actions', 'Executing organize (moves files)...');
  runOrganizer(['--execute', '--yes'], (code, out, err) => {
    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.webContents.send('execute-done', code === 0, code === 0 ? 'Organize finished' : ('Failed: ' + (err || ('Exit code ' + code))));
    }
    if (code === 0) {
      notify('Quick Actions', 'Organize finished');
    } else {
      notify('Quick Actions', 'Organize failed');
      dialog.showErrorBox('Organize failed', err || ('Exit code ' + code));
    }
  });
});

// If preview window asks to show full preview in dialog, open a dialog with raw output (fallback)
ipcMain.on('show-full-preview', () => {
  // We don't have direct raw output here in main, so just open the ops dir or show info
  openOpsDir();
});

// Build grouped data from script stdout (same logic used previously)
function parseDryRunOutput(stdout) {
  const lines = (stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const downloadsBase = path.join(os.homedir(), 'Downloads');
  const grouped = {};
  const skipped = [];

  for (const ln of lines) {
    if (ln.startsWith('MOVE:')) {
      const m = ln.replace(/^MOVE:\s*/, '').split('->').map(s => s.trim());
      if (m.length === 2) {
        const from = m[0];
        const to = m[1];
        const fileName = path.basename(from);
        let rel = '';
        try { rel = path.relative(downloadsBase, path.dirname(to)); } catch(e){ rel = path.dirname(to); }
        const top = rel ? rel.split(path.sep)[0] : (path.basename(path.dirname(to)) || 'Other');
        if (!grouped[top]) grouped[top] = [];
        grouped[top].push(fileName);
      }
    } else if (ln.startsWith('SKIP:')) {
      const s = ln.replace(/^SKIP:\s*/, '').trim();
      skipped.push(path.basename(s));
    }
  }

  return { grouped, skipped, raw: stdout };
}

// App ready: create tray and context menu
app.whenReady().then(async () => {
  console.log('Electron ready — creating tray (HTML preview)');

  // load tray icon if present
  const iconPath = path.join(__dirname, 'tray-icon.png');
  let icon = null;
  if (fs.existsSync(iconPath)) {
    try { icon = nativeImage.createFromPath(iconPath).resize({ width:16, height:16 }); } catch(e) { icon = nativeImage.createEmpty(); }
  } else {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Quick Actions');

  const menu = Menu.buildFromTemplate([

    // Preview (opens HTML window)
    { label: 'Preview: Organize Downloads', type: 'normal', click: () => {
        notify('Quick Actions', 'Running dry-run preview...');
        runOrganizer(['--dry-run'], (code, out, err) => {
          if (err && !out) {
            dialog.showErrorBox('Preview error', err);
            return;
          }
          const parsed = parseDryRunOutput(out || '');
          // limit UI per prefs.previewLimit
          (async () => {
            const prefs = await readConfig();
            const limit = prefs.previewLimit || 200;
            const html = buildPreviewHTML(parsed.grouped, parsed.skipped, parsed.raw || '', limit);
            openPreviewWindow(html);
          })();
        });
      }
    },

    // Direct execute
    { label: 'Execute: Organize Downloads', type: 'normal', click: () => {
        notify('Quick Actions', 'Executing organize (moves files)...');
        runOrganizer(['--execute', '--yes'], (code, out, err) => {
          if (code === 0) {
            notify('Quick Actions', 'Organize finished');
            dialog.showMessageBox({ type: 'info', title: 'Organize - Done', message: 'Organize finished. Check op logs for details.' });
          } else {
            notify('Quick Actions', 'Organize failed');
            dialog.showErrorBox('Organize failed', err || ('Exit code ' + code));
          }
        });
      }
    },

    // Undo
    { label: 'Undo last organize', type: 'normal', click: () => {
        notify('Quick Actions', 'Undoing last operation...');
        runOrganizer(['--undo'], (code, out, err) => {
          if (code === 0) {
            notify('Quick Actions', 'Undo complete');
            dialog.showMessageBox({ type: 'info', title: 'Undo', message: out || 'Undo finished.' });
          } else {
            notify('Quick Actions', 'Undo failed');
            dialog.showErrorBox('Undo failed', err || ('Exit code ' + code));
          }
        });
      }
    },

    { type: 'separator' },
    { label: 'Preferences', type: 'normal', click: () => openPrefsWindow() },
    { label: 'Open op logs', type: 'normal', click: () => openOpsDir() },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' }
  ]);

  tray.setContextMenu(menu);

  // Register hotkey after tray/menu exist
  try {
    const prefs = await readConfig();
    const HOTKEY = 'CommandOrControl+Alt+O';
    if (prefs.enableHotkey !== false) {
      const ok = globalShortcut.register(HOTKEY, () => {
        try {
          if (tray && menu) {
            tray.popUpContextMenu(menu);
          } else {
            notify('Quick Actions', 'Tray not ready yet');
          }
        } catch (e) {
          console.error('Hotkey callback error:', e);
        }
      });

      if (!ok) {
        console.warn('Hotkey registration returned false — possibly in use by OS:', HOTKEY);
        notify('Quick Actions', `Hotkey registration failed: ${HOTKEY}`);
      } else {
        console.log('Registered hotkey:', HOTKEY);
      }
    } else {
      console.log('Hotkey disabled by preferences.');
    }
  } catch (e) {
    console.error('Error registering hotkey:', e);
  }

  tray.on('click', () => tray.popUpContextMenu(menu));
  tray.on('right-click', () => tray.popUpContextMenu(menu));
});

let prefsWindow = null;

async function openPrefsWindow() {
  const currentPrefs = await readConfig();
  if (prefsWindow && !prefsWindow.isDestroyed()) {
    // update content
    prefsWindow.webContents.executeJavaScript(`window.updatePrefs(${JSON.stringify(currentPrefs)})`);
    prefsWindow.focus();
    return;
  }

  prefsWindow = new BrowserWindow({
    width: 700,
    height: 560,
    resizable: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    title: 'Quick Actions — Preferences'
  });

  const prefsHtml = buildPrefsHTML(currentPrefs);
  prefsWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(prefsHtml));
  prefsWindow.on('closed', () => { prefsWindow = null; });
}

// Add IPC handlers for prefs-get/prefs-set
ipcMain.handle('prefs-get', async () => {
  return await readConfig();
});
ipcMain.handle('prefs-set', async (ev, newPrefs) => {
  // persist config and return ok
  await writeConfig(newPrefs);
  // (re-register hotkey according to new prefs)
  try {
    // refresh hotkey registration
    globalShortcut.unregisterAll();
    if (newPrefs.enableHotkey !== false) {
      globalShortcut.register('CommandOrControl+Alt+O', () => {
        try { if (tray) tray.popUpContextMenu(); } catch(e) { console.error('Hotkey event error', e); }
      });
    }
  } catch (e) { console.error('Error updating hotkey after prefs change', e); }
  return { ok: true };
});

function buildPrefsHTML(prefs) {
  const css = `
    body { font-family: system-ui, sans-serif; padding: 12px; color: #222; }
    label { display:block; margin-top:10px; font-weight:600; }
    input[type="text"], textarea { width: 100%; padding:8px; box-sizing:border-box; font-family:monospace; }
    .row { display:flex; gap:10px; align-items:center; }
    .col { flex:1; }
    .controls { margin-top:12px; display:flex; gap:8px; }
    .small { font-size:12px; color:#555; margin-top:6px; }
  `;
  const html = `
  <!doctype html>
  <html>
  <head><meta charset="utf-8"><title>Preferences</title><style>${css}</style></head>
  <body>
    <h2>Quick Actions — Preferences</h2>

    <label>Target folder (where to organize)</label>
    <div class="row"><input id="target" type="text" value="${escapeHtml(prefs.targetFolder || '')}"></div>

    <label>Backup folder (where moved files are kept)</label>
    <div class="row"><input id="backup" type="text" value="${escapeHtml(prefs.backupFolder || '')}"></div>

    <label>Recursive scan</label>
    <div class="row"><input id="recursive" type="checkbox" ${prefs.recursive ? 'checked' : ''}></div>

    <label>Auto-confirm execution (auto 'yes' when running from tray)</label>
    <div class="row"><input id="autoyes" type="checkbox" ${prefs.autoYes ? 'checked' : ''}></div>

    <label>Enable hotkey (Ctrl/Cmd+Alt+O)</label>
    <div class="row"><input id="enableHotkey" type="checkbox" ${prefs.enableHotkey !== false ? 'checked' : ''}></div>

    <label>Preview listing limit (how many filenames to show in preview detail)</label>
    <div class="row"><input id="limit" type="text" value="${prefs.previewLimit || 200}"></div>

    <label style="margin-top:14px">Rules (extension -> subfolder). Edit as JSON. Example: { ".pdf": "Documents" }</label>
    <textarea id="rules" rows="12">${escapeHtml(JSON.stringify(prefs.rules || {}, null, 2))}</textarea>

    <div class="controls">
      <button id="saveBtn">Save</button>
      <button id="resetBtn">Reset to defaults</button>
      <button id="closeBtn">Close</button>
    </div>

    <div id="status" class="small"></div>

    <script>
      const { ipcRenderer } = require('electron');
      function getPrefsFromForm() {
        try {
          return {
            targetFolder: document.getElementById('target').value.trim(),
            backupFolder: document.getElementById('backup').value.trim(),
            recursive: document.getElementById('recursive').checked,
            autoYes: document.getElementById('autoyes').checked,
            enableHotkey: document.getElementById('enableHotkey').checked,
            previewLimit: parseInt(document.getElementById('limit').value, 10) || 200,
            rules: JSON.parse(document.getElementById('rules').value)
          };
        } catch (e) {
          document.getElementById('status').textContent = 'Invalid JSON in rules: ' + e.message;
          return null;
        }
      }
      document.getElementById('saveBtn').addEventListener('click', async () => {
        const prefs = getPrefsFromForm();
        if (!prefs) return;
        const res = await ipcRenderer.invoke('prefs-set', prefs);
        if (res && res.ok) {
          document.getElementById('status').textContent = 'Preferences saved.';
        } else {
          document.getElementById('status').textContent = 'Save failed.';
        }
      });
      document.getElementById('resetBtn').addEventListener('click', async () => {
        const res = await ipcRenderer.invoke('prefs-get');
        // replace with server defaults - we will just overwrite fields with config defaults from main
        document.getElementById('target').value = res.targetFolder || '';
        document.getElementById('backup').value = res.backupFolder || '';
        document.getElementById('recursive').checked = !!res.recursive;
        document.getElementById('autoyes').checked = !!res.autoYes;
        document.getElementById('enableHotkey').checked = !!res.enableHotkey;
        document.getElementById('limit').value = res.previewLimit || 200;
        document.getElementById('rules').value = JSON.stringify(res.rules || {}, null, 2);
        document.getElementById('status').textContent = 'Reset to config defaults.';
      });
      document.getElementById('closeBtn').addEventListener('click', () => window.close());

      // expose update function so main can call it
      window.updatePrefs = (p) => {
        document.getElementById('target').value = p.targetFolder || '';
        document.getElementById('backup').value = p.backupFolder || '';
        document.getElementById('recursive').checked = !!p.recursive;
        document.getElementById('autoyes').checked = !!p.autoYes;
        document.getElementById('enableHotkey').checked = !!p.enableHotkey;
        document.getElementById('limit').value = p.previewLimit || 200;
        document.getElementById('rules').value = JSON.stringify(p.rules || {}, null, 2);
      };
    </script>
  </body>
  </html>
  `;
  return html;
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// ensure cleanup
app.on('window-all-closed', () => {
  // keep running in tray
});
