import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import { spawn, exec } from "child_process";

/* ================= CONFIG ================= */
const PORT_UI = 3000;
const PORT_API = 8081;

const DATA_DIR = path.join(process.cwd(), "data");
const AS_FILE = path.join(DATA_DIR, "as.json");
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");
const EPG_DIR = path.join(DATA_DIR, "epg");
const CHANNELS_BACKUP_DIR = path.join(DATA_DIR, "channels.backups");

const AUTO_REFRESH_MIN = 120;
const EPG_UPDATE_DAYS = 3; // Update EPG every 3 days

/* ================= DIR SETUP ================= */
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(EPG_DIR, { recursive: true });
fs.mkdirSync(CHANNELS_BACKUP_DIR, { recursive: true });

/* ================= APP ================= */
const uiApp = express();
const apiApp = express();

uiApp.use(cors());
uiApp.use(express.json());

apiApp.use(cors());
apiApp.use(express.json());

/* ================= STATE ================= */
let sseClients = [];
let epgLogs = [];

/* ================= UTILS ================= */
function slugify(str) {
  return (str || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function log(msg) {
  const time = new Date().toISOString();
  const entry = `[${time}] ${msg}`;
  console.log(entry);

  epgLogs.push(entry);
  if (epgLogs.length > 1000) epgLogs.shift();

  sseClients.forEach(res => res.write(`data: ${entry}\n\n`));
}

async function executeCurlCommand(curlCommand) {
  return new Promise((resolve, reject) => {
    exec(curlCommand, (error, stdout, stderr) => {
      if (error) {
        log(`❌ Curl command failed: ${error.message}`);
        log(`   Command: ${curlCommand}`);
        reject(error);
      } else {
        const output = stdout.trim();
        const errors = stderr.trim();
        
        if (output) {
          log(`✅ Curl output: ${output}`);
        }
        if (errors) {
          log(`⚠️ Curl stderr: ${errors}`);
        }
        if (!output && !errors) {
          log(`✅ Curl command executed successfully`);
        }
        
        resolve({ stdout: output, stderr: errors });
      }
    });
  });
}

function findEpgFile(channelName) {
  if (!fs.existsSync(EPG_DIR)) {
    return null;
  }
  
  const epgFiles = fs.readdirSync(EPG_DIR).filter(f => f.endsWith('.json'));
  
  const cleanRequested = channelName.toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  for (const epgFile of epgFiles) {
    const fileName = epgFile.replace('.json', '');
    const cleanFileName = fileName.toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    if (cleanRequested === cleanFileName) {
      return epgFile;
    }
    
    if (cleanFileName.includes(cleanRequested) || cleanRequested.includes(cleanFileName)) {
      return epgFile;
    }
    
    const variations = [
      cleanRequested,
      cleanRequested.replace(/ /g, '_'),
      cleanRequested.replace(/ /g, '-'),
      cleanRequested.replace(/[_-]/g, ' ')
    ];
    
    for (const variation of variations) {
      if (cleanFileName.includes(variation) || variation.includes(cleanFileName)) {
        return epgFile;
      }
    }
  }
  
  return null;
}

function convertToEasternTime(date) {
  const options = {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };
  
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(date);
  
  const getPart = (type) => parts.find(p => p.type === type).value;
  
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hour = getPart('hour');
  const minute = getPart('minute');
  const second = getPart('second');
  
  const easternDateStr = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const easternDate = new Date(easternDateStr);
  
  const originalOffset = date.getTimezoneOffset();
  const easternOffset = 300; 
  
  const isDST = date.getMonth() > 2 && date.getMonth() < 11;
  const finalOffset = isDST ? 240 : 300; 
  
  const adjustedDate = new Date(date.getTime() + (originalOffset * 60000) - (finalOffset * 60000));
  
  return adjustedDate;
}

function getEasternUnixTimestamp(date) {
  const easternDate = convertToEasternTime(date);
  return Math.floor(easternDate.getTime() / 1000);
}

function formatEasternReadableTime(date) {
  const easternDate = convertToEasternTime(date);
  const year = easternDate.getFullYear();
  const month = String(easternDate.getMonth() + 1).padStart(2, '0');
  const day = String(easternDate.getDate()).padStart(2, '0');
  const hours = String(easternDate.getHours()).padStart(2, '0');
  const minutes = String(easternDate.getMinutes()).padStart(2, '0');
  const seconds = String(easternDate.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

function backupChannelsFile() {
  if (!fs.existsSync(CHANNELS_FILE)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(CHANNELS_BACKUP_DIR, `channels.${ts}.json`);
  fs.copyFileSync(CHANNELS_FILE, backupFile);
  log(`📦 Backup created: ${path.basename(backupFile)}`);
}

function cleanupOldRollbacks() {
  const now = Date.now();
  const files = fs.readdirSync(CHANNELS_BACKUP_DIR)
    .filter(f => f.startsWith("channels.") && f.endsWith(".json"));

  let deletedFiles = [];
  files.forEach(f => {
    const filePath = path.join(CHANNELS_BACKUP_DIR, f);
    const stats = fs.statSync(filePath);
    const age = now - stats.mtimeMs;
    if (age > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
      deletedFiles.push(f);
    }
  });
  if (deletedFiles.length > 0) {
    log(`🗑 Automatic cleanup: deleted ${deletedFiles.length} old rollback file(s)`);
  }
}

function generateEpgMappings() {
    const epgDir = EPG_DIR;
    const mappings = {};
    if (!fs.existsSync(epgDir)) return mappings;
    const epgFiles = fs.readdirSync(epgDir).filter(file => file.endsWith('.json'));
    epgFiles.forEach(file => {
        const baseName = file.replace('.json', '');
        mappings[baseName] = file;
        mappings[baseName.toLowerCase()] = file;
        const underscoreName = baseName.replace(/\s+/g, '_');
        mappings[underscoreName] = file;
        mappings[underscoreName.toLowerCase()] = file;
        const noSpaceName = baseName.replace(/\s+/g, '');
        mappings[noSpaceName] = file;
        mappings[noSpaceName.toLowerCase()] = file;
        const hyphenName = baseName.replace(/\s+/g, '-');
        mappings[hyphenName] = file;
        mappings[hyphenName.toLowerCase()] = file;
        if (baseName.includes('&')) {
            const andName = baseName.replace('&', 'and');
            mappings[andName] = file;
            mappings[andName.toLowerCase()] = file;
        }
        if (baseName.includes('Fox Business')) {
            mappings['fox_business'] = file;
            mappings['foxbusiness'] = file;
            mappings['fox-business'] = file;
        }
        if (baseName.includes('Fox News')) {
            mappings['fox_news'] = file;
            mappings['foxnews'] = file;
            mappings['fox-news'] = file;
        }
        if (baseName.includes('Food Network')) {
            mappings['food_network'] = file;
            mappings['foodnetwork'] = file;
            mappings['food-network'] = file;
        }
        if (baseName.includes('A&E')) {
            mappings['ae'] = file;
            mappings['a_and_e'] = file;
            mappings['a-e'] = file;
        }
        if (baseName.includes('ESPN')) {
            const espnBase = baseName.replace('ESPN', 'espn');
            mappings[espnBase] = file;
        }
    });
    return mappings;
}

const autoMappings = generateEpgMappings();
const epgFileMappings = {
    "A&E US - Eastern Feed": "ae_us_eastern_feed.json",
    "Syfy - Eastern Feed": "syfy_eastern_feed.json", 
    "TBS - East": "tbs_east.json",
    "TLC USA - Eastern": "tlc_usa_eastern.json",
    "truTV USA - Eastern": "trutv_usa_eastern.json",
    ...autoMappings
};

function parseTimestamp(timestamp) {
    if (!timestamp) return null;
    const timestampNum = parseInt(timestamp);
    if (!isNaN(timestampNum)) {
        if (timestampNum > 1000000000 && timestampNum < 1000000000000) {
            return new Date(timestampNum * 1000);
        } else if (timestampNum > 1000000000000) {
            return new Date(timestampNum);
        }
    }
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) {
        return date;
    }
    return null;
}

function formatUTCISO8601(date) {
    if (!date || isNaN(date.getTime())) return 'Invalid Date';
    const utcYear = date.getUTCFullYear();
    const utcMonth = String(date.getUTCMonth() + 1).padStart(2, '0');
    const utcDay = String(date.getUTCDate()).padStart(2, '0');
    const utcHours = String(date.getUTCHours()).padStart(2, '0');
    const utcMinutes = String(date.getUTCMinutes()).padStart(2, '0');
    const utcSeconds = String(date.getUTCSeconds()).padStart(2, '0');
    return `${utcYear}-${utcMonth}-${utcDay}T${utcHours}:${utcMinutes}:${utcSeconds}Z`;
}

function formatLocalReadableTime(date) {
    if (!date || isNaN(date.getTime())) return 'Invalid Date';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

function formatISO8601DateTime(date) {
    if (!date || isNaN(date.getTime())) return 'Invalid Date';
    const timezoneOffset = date.getTimezoneOffset();
    const offsetHours = Math.abs(Math.floor(timezoneOffset / 60));
    const offsetMinutes = Math.abs(timezoneOffset % 60);
    const offsetSign = timezoneOffset <= 0 ? '+' : '-';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
}

function filterOutPastTodayPrograms(programs, currentTime, epgYear) {
    const filteredPrograms = programs.filter(program => {
        const programStart = new Date(program.iso_start);
        const programEnd = new Date(program.iso_end);
        const comparisonDate = new Date(currentTime);
        comparisonDate.setFullYear(epgYear);
        const today = new Date(comparisonDate);
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const isToday = programStart >= today && programStart < tomorrow;
        const spansMidnight = programStart < today && programEnd >= today;
        if (isToday || spansMidnight) {
            const hasEnded = programEnd < currentTime;
            if (hasEnded) return false;
        }
        return true;
    });
    return filteredPrograms;
}

function debugRealFiltering(allPrograms, filteredPrograms, currentTime, epgYear) {
    const comparisonDate = new Date(currentTime);
    comparisonDate.setFullYear(epgYear);
    const today = new Date(comparisonDate);
    today.setHours(0, 0, 0, 0);
    const allDates = allPrograms.map(p => {
        const date = new Date(p.iso_start);
        return { date: date.getDate(), month: date.getMonth() + 1, fullDate: `${date.getMonth() + 1}/${date.getDate()}`, isPast: date < today };
    });
    const filteredDates = filteredPrograms.map(p => {
        const date = new Date(p.iso_start);
        return { date: date.getDate(), month: date.getMonth() + 1, fullDate: `${date.getMonth() + 1}/${date.getDate()}`, isPast: date < today };
    });
    const uniqueAllDates = [...new Set(allDates.map(d => d.fullDate))].sort();
    const uniqueFilteredDates = [...new Set(filteredDates.map(d => d.fullDate))].sort();
    console.log(`📊 ALL programs dates: ${uniqueAllDates.join(', ')}`);
    console.log(`🎯 FILTERED programs dates: ${uniqueFilteredDates.join(', ')}`);
}

function detectEpgYear(epgData) {
    let programsArray = [];
    if (Array.isArray(epgData)) {
        programsArray = epgData;
    } else if (epgData && typeof epgData === 'object') {
        if (Array.isArray(epgData.programs)) {
            programsArray = epgData.programs;
        } else if (Array.isArray(epgData.epg)) {
            programsArray = epgData.epg;
        } else if (Array.isArray(epgData.schedule)) {
            programsArray = epgData.schedule;
        } else {
            const arrayKeys = Object.keys(epgData).filter(key => Array.isArray(epgData[key]));
            if (arrayKeys.length > 0) {
                programsArray = epgData[arrayKeys[0]];
            }
        }
    }
    const samplePrograms = programsArray.slice(0, 10);
    const yearsFound = new Set();
    samplePrograms.forEach((program) => {
        const startTime = program.start_time || program.start || program.startTime || program.begin || program.time ||
                         program['data-listdatetime'] || program.timestamp;
        if (startTime) {
            const startDate = parseTimestamp(startTime);
            if (startDate && !isNaN(startDate.getTime())) {
                yearsFound.add(startDate.getFullYear());
            }
        }
    });
    if (yearsFound.size > 0) {
        return Array.from(yearsFound)[0];
    }
    return new Date().getFullYear();
}

function isProgramTodayOrFuture(program, currentTime, epgYear) {
    const programStart = parseTimestamp(program.iso_start);
    const programEnd = parseTimestamp(program.iso_end);
    if (!programStart || !programEnd) return false;
    const comparisonDate = new Date(currentTime);
    comparisonDate.setFullYear(epgYear);
    const today = new Date(comparisonDate);
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const startsToday = programStart >= today && programStart < tomorrow;
    const spansMidnight = programStart < today && programEnd >= today;
    const startsFuture = programStart >= tomorrow;
    return startsToday || spansMidnight || startsFuture;
}

function normalizeProgramData(program, index) {
    const startTime = program.start_time || program.start || program.startTime || program.begin || program.time ||
                     program['data-listdatetime'] || program.timestamp;
    const duration = program.duration || program['data-duration'] || 60;

    // --- TITLE FIX LOGIC ---
    const mainTitle = (program.title || program.name || program['data-showname'] || "Unknown").trim();
    const episodeTitle = (program['data-episodetitle'] || "").trim();
    let finalTitle = mainTitle;

    if (mainTitle.toLowerCase() === "movie" && episodeTitle !== "") {
        finalTitle = `Movie - ${episodeTitle}`;
    } else if (episodeTitle !== "" && mainTitle !== episodeTitle) {
        finalTitle = `${mainTitle} - ${episodeTitle}`;
    }
    // --- END TITLE FIX ---

    const description = program.description || program.desc || program['data-description'] || "";
    const dataShowName = program['data-showname'];
    const dataEpisodeTitle = program['data-episodetitle'];
    
    let startDate, endDate;
    try {
        startDate = parseTimestamp(startTime);
        if (!startDate || isNaN(startDate.getTime())) return null;
        let endTimeStr = program.end_time || program.end || program.endTime || program.until;
        if (endTimeStr) {
            endDate = parseTimestamp(endTimeStr);
        }
        if (!endDate && duration) {
            const durationMs = parseInt(duration) * 60 * 1000;
            endDate = new Date(startDate.getTime() + durationMs);
        }
        if (!endDate || isNaN(endDate.getTime())) return null;
    } catch (error) {
        return null;
    }

    return {
        title: finalTitle.replace(/\n/g, ' - ').trim(),
        start_time: startDate.toISOString(),
        end_time: endDate.toISOString(),
        description: description,
        duration: duration,
        original_data: program,
        data_showname: dataShowName,
        data_episodetitle: dataEpisodeTitle,
        original_start_timestamp: startTime,
        original_end_timestamp: program.end_time || program.end || program.endTime || program.until,
        original_index: index,
        iso_start: startDate.toISOString(),
        iso_end: endDate.toISOString()
    };
}

function getTodaysAndFutureEpgData(channelId, raw) {
  const now = new Date();
  const epgYear = detectEpgYear(raw);
  let programsArray = [];
  if (Array.isArray(raw)) {
    programsArray = raw;
  } else if (raw.programs && Array.isArray(raw.programs)) {
    programsArray = raw.programs;
  } else {
    const arrayKeys = Object.keys(raw).filter(key => Array.isArray(raw[key]));
    if (arrayKeys.length > 0) {
      programsArray = raw[arrayKeys[0]];
    } else {
      return { channel: channelId, programs: [] };
    }
  }
  
  const normalizedPrograms = programsArray
    .map((program, index) => normalizeProgramData(program, index))
    .filter(program => program !== null);
  
  const convertedPrograms = normalizedPrograms.map((program) => {
    const startDate = new Date(program.start_time);
    const endDate = new Date(program.end_time);
    const startUnix = Math.floor(startDate.getTime() / 1000);
    const endUnix = Math.floor(endDate.getTime() / 1000);
    const startEasternUnix = getEasternUnixTimestamp(startDate);
    const endEasternUnix = getEasternUnixTimestamp(endDate);
    
    return {
      title: program.title,
      start_utc: formatUTCISO8601(startDate),
      end_utc: formatUTCISO8601(endDate),
      start_time: formatLocalReadableTime(startDate),
      end_time: formatLocalReadableTime(endDate),
      start_utc_timestamp: startUnix.toString(),
      end_utc_timestamp: endUnix.toString(),
      start_eastern_timestamp: startEasternUnix.toString(),
      end_eastern_timestamp: endEasternUnix.toString(),
      start_eastern_time: formatEasternReadableTime(startDate),
      end_eastern_time: formatEasternReadableTime(endDate),
      start_unix: startUnix,
      end_unix: endUnix,
      start_iso: formatISO8601DateTime(startDate),
      end_iso: formatISO8601DateTime(endDate),
      description: program.description,
      iso_start: program.start_time,
      iso_end: program.end_time,
      data_showname: program.data_showname,
      data_episodetitle: program.data_episodetitle,
      original_index: program.original_index
    };
  });
  
  const todaysAndFuturePrograms = convertedPrograms.filter(program => {
    return isProgramTodayOrFuture(program, now, epgYear);
  });

  const currentAndFuturePrograms = filterOutPastTodayPrograms(todaysAndFuturePrograms, now, epgYear);
  debugRealFiltering(convertedPrograms, currentAndFuturePrograms, now, epgYear);

  const sortedPrograms = currentAndFuturePrograms.sort((a, b) => {
    const aStart = parseTimestamp(a.iso_start);
    const bStart = parseTimestamp(b.iso_start);
    return aStart - bStart;
  });

  return { 
    channel: channelId, 
    programs: sortedPrograms,
    epgYear: epgYear,
    totalProcessed: convertedPrograms.length,
    filteredOut: convertedPrograms.length - sortedPrograms.length
  };
}

function loadEpgData(id) {
  const file = path.join(EPG_DIR, `${slugify(id)}.json`);
  if (!fs.existsSync(file)) throw new Error("EPG not found");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function runPythonFetchEPG(channelId = null) {
  return new Promise(resolve => {
    const args = channelId ? [channelId] : [];
    const py = spawn("python", ["fetch_epg5.py", ...args]);
    py.stdout.on("data", d => log(`[PY] ${d.toString().trim()}`));
    py.stderr.on("data", d => log(`[PY ERR] ${d.toString().trim()}`));
    py.on("close", resolve);
  });
}

async function refreshChannels(target = null) {
  backupChannelsFile();
  await runPythonFetchEPG(target);
}

async function updateEpgData() {
  log("🔄 Starting EPG update...");
  return new Promise((resolve) => {
    const epgScript = path.join(process.cwd(), "epg3.py");
    if (!fs.existsSync(epgScript)) {
      log(`❌ EPG script not found: ${epgScript}`);
      resolve(false);
      return;
    }
    log(`📜 Running EPG updater: ${epgScript}`);
    const py = spawn("python", [epgScript]);
    py.stdout.on("data", d => log(`[EPG Update] ${d.toString().trim()}`));
    py.stderr.on("data", d => log(`[EPG Update Error] ${d.toString().trim()}`));
    py.on("close", (code) => {
      if (code === 0) log("✅ EPG update completed successfully");
      else log(`❌ EPG update failed with code: ${code}`);
      resolve(code === 0);
    });
    py.on("error", (err) => {
      log(`❌ Failed to start EPG updater: ${err.message}`);
      resolve(false);
    });
  });
}

async function checkAndUpdateEpg() {
  const lastUpdateFile = path.join(DATA_DIR, "last_epg_update.txt");
  const now = new Date();
  try {
    if (fs.existsSync(lastUpdateFile)) {
      const lastUpdateStr = fs.readFileSync(lastUpdateFile, "utf8").trim();
      const lastUpdate = new Date(lastUpdateStr);
      const daysSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate < EPG_UPDATE_DAYS) return;
    }
    await updateEpgData();
    fs.writeFileSync(lastUpdateFile, now.toISOString());
  } catch (error) {
    log(`❌ Error checking EPG update: ${error.message}`);
  }
}

uiApp.post("/api/start-stream/:channelId", async (req, res) => {
  try {
    const channelId = req.params.channelId;
    if (!fs.existsSync(CHANNELS_FILE)) return res.status(404).json({ error: "Channels file not found" });
    const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
    const channel = channels.find(c => c.id === channelId);
    if (!channel) return res.status(404).json({ error: `Channel ${channelId} not found` });
    if (!channel.url) return res.status(400).json({ error: `No URL for channel ${channelId}` });
    const escapedUrl = channel.url.replace(/'/g, "\\'");
    const curlCommand = `curl -X POST http://10.0.0.199:5000/start-stream -H "Content-Type: application/json" -d '{"url": "${escapedUrl}", "session_id": "${channelId}"}'`;
    log(`📡 Executing curl command for ${channelId}: ${curlCommand}`);
    const result = await executeCurlCommand(curlCommand);
    res.json({ success: true, message: `Stream started for ${channelId}`, channel: channelId, command: curlCommand, output: result.stdout });
  } catch (error) {
    log(`❌ Failed to start stream: ${error.message}`);
    res.status(500).json({ error: "Failed to start stream", details: error.message });
  }
});

uiApp.get("/", (req, res) => {
  const channels = fs.existsSync(CHANNELS_FILE) ? JSON.parse(fs.readFileSync(CHANNELS_FILE)) : [];
  const channelHTML = channels.map(c => {
    const escapedUrl = c.url ? c.url.replace(/"/g, '&quot;').replace(/'/g, "\\'") : '';
    return `<div class="channel">${c.name}<button onclick="refreshOne('${c.id}')">🔄</button><button class="start-stream-btn" onclick="startStream('${c.id}', '${escapedUrl}')">▶️ Start Stream</button></div>`;
  }).join("");

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>IPTV Server</title><style>body{font-family:Arial;background:#111;color:#eee;padding:20px}.channel{padding:8px;border-bottom:1px solid #333}button,select{margin:5px;padding:6px 10px}#log{background:#000;padding:10px;height:400px;overflow:auto;margin-top:10px}.epg-status {display:inline-block; margin-left:10px; padding:2px 8px; border-radius:3px; font-size:12px;}.epg-up-to-date {background:#28a745; color:white;}.epg-needs-update {background:#ffc107; color:black;}.start-stream-btn {background:#007bff; color:white; border:none; border-radius:3px; padding:4px 8px; font-size:12px; cursor:pointer;}.start-stream-btn:hover {background:#0056b3;}.command-display {background:#222; color:#0f0; padding:10px; margin:5px 0; font-family:monospace; border-radius:3px; font-size:12px; overflow-x:auto; white-space:nowrap;}</style></head><body><h1>📡 IPTV Server</h1><a href="/channel-list.json">Channels</a> | <a href="/playlist.m3u">Playlist</a><br><br><button onclick="refreshAll()">🔁 Refresh ALL</button><button onclick="updateEPG()">📺 Update EPG</button><button onclick="clearLog()">🧹 Clear Log</button><br><br><select id="rollbackSelect"><option value="">⏪ Rollback channels.json…</option></select><button onclick="rollback()">Restore</button><div id="epgStatus"></div><div id="log"></div>${channelHTML}<script>const logDiv = document.getElementById("log");const epgStatusDiv = document.getElementById("epgStatus");const es = new EventSource("/events");es.onmessage = e => {const msg = e.data;logDiv.innerHTML = msg + "<br>" + logDiv.innerHTML;if (msg.includes("EPG update")) {updateEpgStatus();}};function refreshAll() {fetch("/api/scraper/refresh", { method: "POST" });}function refreshOne(id) {fetch("/api/scraper/refresh/" + id, { method: "POST" });}function updateEPG() {if (confirm("Update EPG data from sources? This may take a few minutes.")) {fetch("/api/epg/update", { method: "POST" }).then(res => res.json()).then(data => {if (data.started) alert("EPG update started! Check logs for progress.");});}}function clearLog() { logDiv.innerHTML = ""; }async function startStream(channelId, streamUrl) {logDiv.innerHTML = \`📡 Starting stream for \${channelId}...<br>\` + logDiv.innerHTML;try {const response = await fetch(\`/api/start-stream/\${channelId}\`, {method: 'POST', headers: {'Content-Type': 'application/json'}});const result = await response.json();if (response.ok) {logDiv.innerHTML = \`✅ Stream started for \${channelId}: \${result.message}<br>\` + logDiv.innerHTML;const commandDisplay = document.createElement('div');commandDisplay.className = 'command-display';commandDisplay.textContent = result.command;logDiv.insertBefore(commandDisplay, logDiv.firstChild);alert(\`✅ Stream started for \${channelId}!\`);} else {logDiv.innerHTML = \`❌ Failed to start stream for \${channelId}: \${result.error || 'Unknown error'}<br>\` + logDiv.innerHTML;alert(\`❌ Failed to start stream: \${result.error || 'Unknown error'}\`);}} catch (error) {logDiv.innerHTML = \`❌ Error starting stream for \${channelId}: \${error.message}<br>\` + logDiv.innerHTML;alert(\`❌ Connection error: \${error.message}\`);}}async function loadRollbackList() {const r = await fetch("/api/channels/rollback/list");const files = await r.json();const sel = document.getElementById("rollbackSelect");sel.innerHTML = '<option value="">⏪ Rollback channels.json…</option>';files.forEach(f => {const o = document.createElement("option");o.value = f;o.textContent = f;sel.appendChild(o);});}async function rollback() {const sel = document.getElementById("rollbackSelect");if (!sel.value) return;if (!confirm("Rollback to " + sel.value + "?")) return;await fetch("/api/channels/rollback/" + sel.value, { method: "POST" });loadRollbackList();}async function updateEpgStatus() {try {const response = await fetch("/api/epg/status");const data = await response.json();let statusHtml = \`<h3>📺 EPG Status</h3>\`;statusHtml += \`<p>Last update: \${data.lastUpdate ? new Date(data.lastUpdate).toLocaleString() : 'Never'}</p>\`;statusHtml += \`<p>Next update in: \${data.nextUpdateIn}</p>\`;statusHtml += \`<p>EPG files: \${data.epgFilesCount}</p>\`;if (data.needsUpdate) {statusHtml += \`<p class="epg-status epg-needs-update">⚠️ EPG update needed</p>\`;} else {statusHtml += \`<p class="epg-status epg-up-to-date">✅ EPG up to date</p>\`;}epgStatusDiv.innerHTML = statusHtml;} catch (error) {epgStatusDiv.innerHTML = \`<p>⚠️ Could not load EPG status</p>\`;}}loadRollbackList();updateEpgStatus();setInterval(updateEpgStatus, 5 * 60 * 1000);</script></body></html>`);
});

uiApp.get("/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  sseClients.push(res);
  req.on("close", () => sseClients = sseClients.filter(c => c !== res));
});

uiApp.get("/channel-list.json", (req, res) => {
  res.json(fs.existsSync(CHANNELS_FILE) ? JSON.parse(fs.readFileSync(CHANNELS_FILE)) : []);
});

uiApp.get("/playlist.m3u", (req, res) => {
  if (!fs.existsSync(CHANNELS_FILE)) return res.send("#EXTM3U\n# No channels found");
  const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE));
  const m3u = ["#EXTM3U"];
  channels.forEach(c => {
    m3u.push(`#EXTINF:-1 tvg-id="${c.id}" tvg-name="${c.name}" tvg-logo="${c.logo}",${c.name}`);
    m3u.push(c.url);
  });
  res.set("Content-Type", "audio/x-mpegurl");
  res.send(m3u.join("\n"));
});

uiApp.post("/api/scraper/refresh", async (req, res) => {
  await refreshChannels();
  res.json({ started: true });
});

uiApp.post("/api/scraper/refresh/:id", async (req, res) => {
  await refreshChannels(req.params.id);
  res.json({ started: true });
});

uiApp.post("/api/epg/update", async (req, res) => {
  const success = await updateEpgData();
  res.json({ started: true, success });
});

uiApp.get("/api/epg/status", (req, res) => {
  const lastUpdateFile = path.join(DATA_DIR, "last_epg_update.txt");
  const now = new Date();
  let lastUpdate = null;
  let needsUpdate = true;
  let nextUpdateIn = "Now";
  try {
    if (fs.existsSync(lastUpdateFile)) {
      const lastUpdateStr = fs.readFileSync(lastUpdateFile, "utf8").trim();
      lastUpdate = new Date(lastUpdateStr);
      const daysSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate < EPG_UPDATE_DAYS) {
        needsUpdate = false;
        nextUpdateIn = `${(EPG_UPDATE_DAYS - daysSinceUpdate).toFixed(1)} days`;
      }
    }
  } catch (error) {}
  const epgFiles = fs.existsSync(EPG_DIR) ? fs.readdirSync(EPG_DIR).filter(f => f.endsWith('.json')).length : 0;
  res.json({ lastUpdate: lastUpdate ? lastUpdate.toISOString() : null, needsUpdate, nextUpdateIn, epgFilesCount: epgFiles });
});

uiApp.use("/api", async (req, res) => {
  try {
    const targetUrl = `http://localhost:${PORT_API}` + req.originalUrl.replace(/^\/api/, "");
    const r = await fetch(targetUrl, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: req.method === "GET" ? undefined : JSON.stringify(req.body)
    });
    const text = await r.text();
    res.status(r.status).send(text);
  } catch (error) {
    res.status(500).send("API proxy error");
  }
});

apiApp.get("/channel-list.json", (req, res) => {
  res.json(fs.existsSync(CHANNELS_FILE) ? JSON.parse(fs.readFileSync(CHANNELS_FILE)) : []);
});

apiApp.get("/channels/rollback/list", (req, res) => {
  const files = fs.readdirSync(CHANNELS_BACKUP_DIR).filter(f => f.startsWith("channels.") && f.endsWith(".json")).sort().reverse();
  res.json(files);
});

apiApp.post("/channels/rollback/:file", (req, res) => {
  const src = path.join(CHANNELS_BACKUP_DIR, req.params.file);
  if (!fs.existsSync(src)) return res.sendStatus(404);
  backupChannelsFile();
  fs.copyFileSync(src, CHANNELS_FILE);
  log(`⏪ Rolled back → ${req.params.file}`);
  res.json({ restored: true });
});

apiApp.get("/channels/:channel.json", (req, res) => {
  const requestedChannel = req.params.channel.replace('.json', '');
  try {
    const foundFile = findEpgFile(requestedChannel);
    if (!foundFile) return res.json({ channel: requestedChannel, programs: [] });
    const filePath = path.join(EPG_DIR, foundFile);
    const rawEpg = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const filteredEpg = getTodaysAndFutureEpgData(requestedChannel, rawEpg);
    res.json(filteredEpg);
  } catch (error) {
    res.json({ channel: requestedChannel, programs: [] });
  }
});

if (AUTO_REFRESH_MIN > 0) setInterval(refreshChannels, AUTO_REFRESH_MIN * 60000);
setInterval(cleanupOldRollbacks, 24 * 60 * 60 * 1000);
cleanupOldRollbacks();
setTimeout(() => checkAndUpdateEpg(), 10000);
setInterval(checkAndUpdateEpg, 6 * 60 * 60 * 1000);

uiApp.listen(PORT_UI, () => {
  log(`📡 UI http://localhost:${PORT_UI}`);
});
apiApp.listen(PORT_API, () => log(`📡 API http://localhost:${PORT_API}`));
