// configHelper.js
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.quick-actions');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// default prefs
const DEFAULT_PREFS = {
  targetFolder: path.join(os.homedir(), 'Downloads'),
  backupFolder: path.join(os.homedir(), '.quick-actions', 'backup'),
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
    ".mp4": "Videos",
    ".mkv": "Videos",
    ".mp3": "Audio"
  },
  recursive: false,
  autoYes: false,
  previewLimit: 200
};

async function ensureConfigDir() {
  try { await fsPromises.mkdir(CONFIG_DIR, { recursive: true }); } catch(e){}
}

async function readConfig() {
  try {
    await ensureConfigDir();
    if (!fs.existsSync(CONFIG_PATH)) {
      await fsPromises.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_PREFS, null, 2), 'utf8');
      return DEFAULT_PREFS;
    }
    const txt = await fsPromises.readFile(CONFIG_PATH, 'utf8');
    const obj = JSON.parse(txt);
    return Object.assign({}, DEFAULT_PREFS, obj);
  } catch (err) {
    console.warn('Failed to read config, using defaults', err);
    return DEFAULT_PREFS;
  }
}

async function writeConfig(obj) {
  try {
    await ensureConfigDir();
    await fsPromises.writeFile(CONFIG_PATH, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to write config', err);
    throw err;
  }
}

module.exports = {
  CONFIG_PATH,
  readConfig,
  writeConfig,
  DEFAULT_PREFS
};
