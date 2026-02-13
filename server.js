import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import { spawn } from "child_process";

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

// ============== ADDED FUNCTION FOR EPG FILE MATCHING ==============
function findEpgFile(channelName) {
  if (!fs.existsSync(EPG_DIR)) {
    return null;
  }
  
  const epgFiles = fs.readdirSync(EPG_DIR).filter(f => f.endsWith('.json'));
  
  // Clean the requested channel name
  const cleanRequested = channelName.toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Try to find matching file
  for (const epgFile of epgFiles) {
    const fileName = epgFile.replace('.json', '');
    const cleanFileName = fileName.toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Exact match
    if (cleanRequested === cleanFileName) {
      return epgFile;
    }
    
    // Contains match
    if (cleanFileName.includes(cleanRequested) || cleanRequested.includes(cleanFileName)) {
      return epgFile;
    }
    
    // Try with underscores/hyphens variations
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
// ============== END ADDED FUNCTION ==============

// ============== ADD: EASTERN TIME CONVERSION FUNCTIONS ==============
function convertToEasternTime(date) {
  // Convert date to Eastern Time (America/New_York)
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
  
  // Create Eastern Time date object
  // Note: Eastern Time is UTC-5 (or UTC-4 during DST)
  // We'll let JavaScript handle the DST conversion
  const easternDateStr = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const easternDate = new Date(easternDateStr);
  
  // Apply Eastern Time offset
  // Get the timezone offset in minutes for the original date
  const originalOffset = date.getTimezoneOffset();
  const easternOffset = 300; // Eastern Standard Time is UTC-5 (300 minutes)
  
  // Adjust for DST if needed (simplified - in practice you'd use a library)
  const isDST = date.getMonth() > 2 && date.getMonth() < 11;
  const finalOffset = isDST ? 240 : 300; // DST: UTC-4 (240 min), Standard: UTC-5 (300 min)
  
  // Create date with correct offset
  const adjustedDate = new Date(date.getTime() + (originalOffset * 60000) - (finalOffset * 60000));
  
  return adjustedDate;
}

function getEasternUnixTimestamp(date) {
  // Get Unix timestamp for Eastern Time (accounting for DST)
  const easternDate = convertToEasternTime(date);
  
  // Convert to Unix timestamp (seconds)
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
  
  // Format: "2025-10-15T20:00:00" (Eastern Time)
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}
// ============== END EASTERN TIME FUNCTIONS ==============

/* ================= CHANNEL BACKUP ================= */
function backupChannelsFile() {
  if (!fs.existsSync(CHANNELS_FILE)) return;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(
    CHANNELS_BACKUP_DIR,
    `channels.${ts}.json`
  );

  fs.copyFileSync(CHANNELS_FILE, backupFile);
  log(`📦 Backup created: ${path.basename(backupFile)}`);
}

/* ================= ROLLBACK CLEANUP ================= */
function cleanupOldRollbacks() {
  const now = Date.now();
  const files = fs.readdirSync(CHANNELS_BACKUP_DIR)
    .filter(f => f.startsWith("channels.") && f.endsWith(".json"));

  let deletedFiles = [];

  files.forEach(f => {
    const filePath = path.join(CHANNELS_BACKUP_DIR, f);
    const stats = fs.statSync(filePath);
    const age = now - stats.mtimeMs; // age in ms
    if (age > 24 * 60 * 60 * 1000) { // older than 24 hours
      fs.unlinkSync(filePath);
      deletedFiles.push(f);
    }
  });

  if (deletedFiles.length > 0) {
    log(`🗑 Automatic cleanup: deleted ${deletedFiles.length} old rollback file(s)`);
  }
}

// ====================
// AUTOMATIC EPG MAPPING GENERATION
// ====================

function generateEpgMappings() {
    const epgDir = EPG_DIR; // Use the existing EPG_DIR constant
    const mappings = {};
    
    if (!fs.existsSync(epgDir)) {
        console.log('❌ EPG directory not found for automatic mapping generation');
        return mappings;
    }
    
    const epgFiles = fs.readdirSync(epgDir).filter(file => file.endsWith('.json'));
    console.log(`🔧 Generating automatic mappings for ${epgFiles.length} EPG files`);
    
    epgFiles.forEach(file => {
        const baseName = file.replace('.json', '');
        
        // 1. Original filename
        mappings[baseName] = file;
        
        // 2. Lowercase version
        mappings[baseName.toLowerCase()] = file;
        
        // 3. Underscore version (replace spaces with underscores)
        const underscoreName = baseName.replace(/\s+/g, '_');
        mappings[underscoreName] = file;
        
        // 4. Lowercase underscore version
        mappings[underscoreName.toLowerCase()] = file;
        
        // 5. No spaces version
        const noSpaceName = baseName.replace(/\s+/g, '');
        mappings[noSpaceName] = file;
        
        // 6. Lowercase no spaces version
        mappings[noSpaceName.toLowerCase()] = file;
        
        // 7. Hyphen version (replace spaces with hyphens)
        const hyphenName = baseName.replace(/\s+/g, '-');
        mappings[hyphenName] = file;
        
        // 8. Lowercase hyphen version
        mappings[hyphenName.toLowerCase()] = file;
        
        // 9. Common abbreviations and variations
        if (baseName.includes('&')) {
            const andName = baseName.replace('&', 'and');
            mappings[andName] = file;
            mappings[andName.toLowerCase()] = file;
        }
        
        // 10. Special cases for common channel patterns
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
        
        console.log(`   ✅ Generated mappings for: ${baseName}`);
    });
    
    console.log(`🎉 Generated ${Object.keys(mappings).length} total mappings`);
    return mappings;
}

// Generate automatic mappings on server start
const autoMappings = generateEpgMappings();

// Combine with manual mappings (manual mappings take priority)
const epgFileMappings = {
    // Manual mappings (for specific overrides or special cases)
    "A&E US - Eastern Feed": "ae_us_eastern_feed.json",
    "Syfy - Eastern Feed": "syfy_eastern_feed.json", 
    "TBS - East": "tbs_east.json",
    "TLC USA - Eastern": "tlc_usa_eastern.json",
    "truTV USA - Eastern": "trutv_usa_eastern.json",
    
    // Add all auto-generated mappings
    ...autoMappings
};

// ====================
// ENHANCED TIME FUNCTIONS FOR EPGTASK COMPATIBILITY
// ====================

// Function to detect and parse timestamp format - REPLACES THE EXISTING FUNCTION
function parseTimestamp(timestamp) {
    if (!timestamp) return null;
    
    // Try as Unix timestamp (seconds or milliseconds)
    const timestampNum = parseInt(timestamp);
    if (!isNaN(timestampNum)) {
        // Determine if it's seconds or milliseconds
        if (timestampNum > 1000000000 && timestampNum < 1000000000000) {
            // It's in seconds (typical Unix timestamp range)
            return new Date(timestampNum * 1000);
        } else if (timestampNum > 1000000000000) {
            // It's in milliseconds
            return new Date(timestampNum);
        }
    }
    
    // Try as ISO string or other date string
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) {
        return date;
    }
    
    return null;
}

// Function to format as UTC ISO 8601 (for EPGTask UTC fields)
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

// FIXED: Function to format as local readable time for display WITH "T" FORMAT
function formatLocalReadableTime(date) {
    if (!date || isNaN(date.getTime())) return 'Invalid Date';
    
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    // FIXED: Format: "2025-10-15T13:00:00" - EPGTask can parse this BETTER
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

// Function to format as ISO 8601 with timezone offset (for EPGTask local time parsing)
function formatISO8601DateTime(date) {
    if (!date || isNaN(date.getTime())) return 'Invalid Date';
    
    // Get timezone offset in minutes
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

// NEW FUNCTION: Filter out past programs from today (time-of-day filtering)
function filterOutPastTodayPrograms(programs, currentTime, epgYear) {
    console.log(`   ⏰ Applying time-of-day filtering...`);
    console.log(`   🕒 Current server time: ${currentTime.toLocaleString()}`);
    
    const filteredPrograms = programs.filter(program => {
        const programStart = new Date(program.iso_start);
        const programEnd = new Date(program.iso_end);
        
        // Check if program is from today using EPG year
        const comparisonDate = new Date(currentTime);
        comparisonDate.setFullYear(epgYear);
        const today = new Date(comparisonDate);
        today.setHours(0, 0, 0, 0);
        
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        const isToday = programStart >= today && programStart < tomorrow;
        const spansMidnight = programStart < today && programEnd >= today;
        
        if (isToday || spansMidnight) {
            // For today's programs, only keep if they haven't ended yet
            const hasEnded = programEnd < currentTime;
            if (hasEnded) {
                console.log(`   🗑️  Filtered out past today program: "${program.title}" (Ended: ${programEnd.toLocaleTimeString()})`);
                return false;
            }
        }
        
        return true;
    });
    
    const pastTodayFiltered = programs.length - filteredPrograms.length;
    console.log(`   🗑️  Past today programs filtered out: ${pastTodayFiltered}`);
    
    return filteredPrograms;
}

// NEW FUNCTION: Add accurate filtering debug
function debugRealFiltering(allPrograms, filteredPrograms, currentTime, epgYear) {
    console.log('\n=== REAL FILTERING VERIFICATION ===');
    
    // Get today's date using EPG year for accurate comparison
    const comparisonDate = new Date(currentTime);
    comparisonDate.setFullYear(epgYear);
    const today = new Date(comparisonDate);
    today.setHours(0, 0, 0, 0);
    
    // Check dates in ALL programs
    const allDates = allPrograms.map(p => {
        const date = new Date(p.iso_start);
        return {
            date: date.getDate(),
            month: date.getMonth() + 1,
            fullDate: `${date.getMonth() + 1}/${date.getDate()}`,
            isPast: date < today
        };
    });
    
    // Check dates in FILTERED programs  
    const filteredDates = filteredPrograms.map(p => {
        const date = new Date(p.iso_start);
        return {
            date: date.getDate(),
            month: date.getMonth() + 1, 
            fullDate: `${date.getMonth() + 1}/${date.getDate()}`,
            isPast: date < today
        };
    });
    
    const uniqueAllDates = [...new Set(allDates.map(d => d.fullDate))].sort();
    const uniqueFilteredDates = [...new Set(filteredDates.map(d => d.fullDate))].sort();
    
    console.log(`📊 ALL programs dates: ${uniqueAllDates.join(', ')}`);
    console.log(`🎯 FILTERED programs dates: ${uniqueFilteredDates.join(', ')}`);
    console.log(`🗑️  ACTUAL filtered out: ${allPrograms.length - filteredPrograms.length}`);
    console.log(`📅 Today's date (using EPG year): ${today.toLocaleDateString()}`);
    
    // Verify no past dates in filtered
    const pastInFiltered = filteredDates.filter(d => d.isPast);
    if (pastInFiltered.length > 0) {
        console.log(`❌ ERROR: Found ${pastInFiltered.length} past programs in filtered results!`);
        pastInFiltered.forEach(p => {
            console.log(`   - ${p.fullDate} (PAST DATE)`);
        });
    } else {
        console.log(`✅ SUCCESS: No past dates in filtered results - filtering is working correctly!`);
    }
    
    // Check if we have today's date in filtered
    const todayDate = today.getDate();
    const todayMonth = today.getMonth() + 1;
    const hasToday = filteredDates.some(d => d.date === todayDate && d.month === todayMonth);
    console.log(`📅 Contains today's programs: ${hasToday ? '✅ YES' : '❌ NO'}`);
}

// NEW FUNCTION: Detect EPG year from the data
function detectEpgYear(epgData) {
    let programsArray = [];
    
    // Extract programs array from different container formats
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
            // Try to find any array property
            const arrayKeys = Object.keys(epgData).filter(key => Array.isArray(epgData[key]));
            if (arrayKeys.length > 0) {
                programsArray = epgData[arrayKeys[0]];
            }
        }
    }
    
    // Analyze first few programs to detect the year
    const samplePrograms = programsArray.slice(0, 10);
    const yearsFound = new Set();
    
    samplePrograms.forEach((program, index) => {
        const startTime = program.start_time || program.start || program.startTime || program.begin || program.time ||
                         program['data-listdatetime'] || program.timestamp;
        
        if (startTime) {
            const startDate = parseTimestamp(startTime);
            if (startDate && !isNaN(startDate.getTime())) {
                yearsFound.add(startDate.getFullYear());
                console.log(`   🔍 Program ${index} year: ${startDate.getFullYear()} from timestamp: ${startTime}`);
            }
        }
    });
    
    // Determine the most common year
    if (yearsFound.size > 0) {
        const yearsArray = Array.from(yearsFound);
        const detectedYear = yearsArray[0]; // Use first found year
        console.log(`   📅 Detected EPG year: ${detectedYear} from available years: ${Array.from(yearsFound).join(', ')}`);
        return detectedYear;
    }
    
    // Fallback: return current year
    const currentYear = new Date().getFullYear();
    console.log(`   ⚠️  Could not detect EPG year, using current year: ${currentYear}`);
    return currentYear;
}

// FIXED: Function to check if a program is from today or future using EPG year for date comparisons
function isProgramTodayOrFuture(program, currentTime, epgYear) {
    const programStart = parseTimestamp(program.iso_start);
    const programEnd = parseTimestamp(program.iso_end);
    
    if (!programStart || !programEnd) {
        console.log(`   ⚠️  Invalid program dates for: "${program.title}"`);
        return false;
    }
    
    // Create comparison date using the EPG year but current month/day
    const comparisonDate = new Date(currentTime);
    comparisonDate.setFullYear(epgYear);
    
    // Get today's date at midnight (start of day) using EPG year
    const today = new Date(comparisonDate);
    today.setHours(0, 0, 0, 0);
    
    // Get tomorrow's date at midnight
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Program is from today or future if:
    // 1. It starts today OR
    // 2. It starts yesterday but ends today (spans midnight) OR  
    // 3. It starts in the future
    const startsToday = programStart >= today && programStart < tomorrow;
    const spansMidnight = programStart < today && programEnd >= today;
    const startsFuture = programStart >= tomorrow;
    
    const isTodayOrFuture = startsToday || spansMidnight || startsFuture;
    
    return isTodayOrFuture;
}

// Function to get current time for filtering - USE REAL CURRENT TIME
function getCurrentTime() {
    return new Date();
}

// ============== UPDATED: ENHANCED PROGRAM NORMALIZATION FUNCTION ==============
function normalizeProgramData(program, index) {
    // Handle data-* field names
    const startTime = program.start_time || program.start || program.startTime || program.begin || program.time ||
                     program['data-listdatetime'] || program.timestamp;
    const duration = program.duration || program['data-duration'] || 60; // Default to 60 minutes
    const title = program.title || program.name || program['data-showname'] || program['data-episodetitle'] || "Unknown";
    const description = program.description || program.desc || program['data-description'] || "";
    const dataShowName = program['data-showname'];
    const dataEpisodeTitle = program['data-episodetitle'];
    
    // Handle Unix timestamp conversion
    let startDate, endDate;
    
    try {
        // Parse start time using our enhanced timestamp parser
        startDate = parseTimestamp(startTime);
        
        if (!startDate || isNaN(startDate.getTime())) {
            console.log(`   ⚠️  [${index}] Invalid start time for "${title}": ${startTime}`);
            return null;
        }
        
        console.log(`   ⏰ [${index}] Parsed start time: ${startDate.toLocaleString()} from: ${startTime}`);
        
        // Calculate end time
        let endTimeStr = program.end_time || program.end || program.endTime || program.until;
        
        if (endTimeStr) {
            // Parse end time using our enhanced timestamp parser
            endDate = parseTimestamp(endTimeStr);
            if (endDate && !isNaN(endDate.getTime())) {
                console.log(`   ⏰ [${index}] Parsed end time: ${endDate.toLocaleString()} from: ${endTimeStr}`);
            } else {
                console.log(`   ⚠️  [${index}] Invalid end time for "${title}": ${endTimeStr}`);
                endDate = null;
            }
        }
        
        if (!endDate && duration) {
            // Calculate end time from start time + duration
            const durationMs = parseInt(duration) * 60 * 1000;
            if (!isNaN(durationMs)) {
                endDate = new Date(startDate.getTime() + durationMs);
                console.log(`   ⏱️  [${index}] Calculated end time from duration: ${endDate.toLocaleString()}`);
            } else {
                console.log(`   ⚠️  [${index}] Invalid duration for "${title}": ${duration}`);
                endDate = null;
            }
        }
        
        if (!endDate || isNaN(endDate.getTime())) {
            console.log(`   ⚠️  [${index}] Skipping program "${title}" - cannot determine valid end time`);
            return null;
        }
        
    } catch (error) {
        console.log(`   ⚠️  [${index}] Error parsing times for "${title}":`, error.message);
        return null;
    }

    return {
        title: title.replace(/\n/g, ' - ').trim(),
        start_time: startDate.toISOString(), // Keep ISO for internal processing
        end_time: endDate.toISOString(),     // Keep ISO for internal processing
        description: description,
        duration: duration,
        // Keep original data for reference including the data fields
        original_data: program,
        // Also keep the individual data fields for debugging
        data_showname: dataShowName,
        data_episodetitle: dataEpisodeTitle,
        // Keep original timestamps for debugging
        original_start_timestamp: startTime,
        original_end_timestamp: program.end_time || program.end || program.endTime || program.until,
        // Keep original index for debugging
        original_index: index,
        // Add these fields for EPGTask compatibility
        iso_start: startDate.toISOString(),
        iso_end: endDate.toISOString()
    };
}
// ============== END UPDATED FUNCTION ==============

/* ================= EPG ================= */
// UPDATED FUNCTION: Handle both regular and data-* field formats with detailed debugging
function getTodaysAndFutureEpgData(channelId, raw) {
  const now = new Date();
  const epgYear = detectEpgYear(raw);
  
  // Check if raw is already an array (your CNBC format)
  let programsArray = [];
  if (Array.isArray(raw)) {
    // Direct array format like your CNBC file
    programsArray = raw;
    console.log(`   📊 Processing direct array format with ${programsArray.length} programs`);
  } else if (raw.programs && Array.isArray(raw.programs)) {
    // Normal format with programs array
    programsArray = raw.programs;
    console.log(`   📊 Processing programs array with ${programsArray.length} programs`);
  } else {
    // Try to find any array in the object
    const arrayKeys = Object.keys(raw).filter(key => Array.isArray(raw[key]));
    if (arrayKeys.length > 0) {
      programsArray = raw[arrayKeys[0]];
      console.log(`   📊 Processing "${arrayKeys[0]}" array with ${programsArray.length} programs`);
    } else {
      console.log(`   ❌ No program array found in EPG data`);
      return { channel: channelId, programs: [] };
    }
  }
  
  // Parse each program with detailed debugging
  const normalizedPrograms = programsArray
    .map((program, index) => normalizeProgramData(program, index))
    .filter(program => program !== null);
  
  console.log(`   ✅ Normalized ${normalizedPrograms.length} programs`);
  
  // Convert to EPGTASK-COMPATIBLE format with PROPER TIMESTAMP FORMATS
  const convertedPrograms = normalizedPrograms.map((program) => {
    const startDate = new Date(program.start_time);
    const endDate = new Date(program.end_time);
    
    // Calculate Unix timestamps (seconds since epoch)
    const startUnix = Math.floor(startDate.getTime() / 1000);
    const endUnix = Math.floor(endDate.getTime() / 1000);
    
    // CALCULATE EASTERN TIME TIMESTAMPS FOR REMINDERS
    const startEasternUnix = getEasternUnixTimestamp(startDate);
    const endEasternUnix = getEasternUnixTimestamp(endDate);
    
    // Debug logging for timestamps
    console.log(`   ⏰ Program: "${program.title}"`);
    console.log(`      Original start: ${startDate.toISOString()}`);
    console.log(`      Original end: ${endDate.toISOString()}`);
    console.log(`      Eastern time: ${formatEasternReadableTime(startDate)}`);
    console.log(`      Eastern Unix: ${startEasternUnix} (${new Date(startEasternUnix * 1000).toLocaleString()})`);
    
    // Format times for EPGTask compatibility
    const startTimeUTC = formatUTCISO8601(startDate);
    const endTimeUTC = formatUTCISO8601(endDate);
    const startTimeLocal = formatLocalReadableTime(startDate);
    const endTimeLocal = formatLocalReadableTime(endDate);
    const startTimeISO = formatISO8601DateTime(startDate);
    const endTimeISO = formatISO8601DateTime(endDate);
    
    return {
      // EPGTASK REQUIRED FIELDS
      title: program.title,
      start_utc: startTimeUTC,
      end_utc: endTimeUTC,
      start_time: startTimeLocal,
      end_time: endTimeLocal,
      start_utc_timestamp: startUnix.toString(),
      end_utc_timestamp: endUnix.toString(),
      
      // ADD EASTERN TIME FIELDS FOR REMINDERS
      start_eastern_timestamp: startEasternUnix.toString(),
      end_eastern_timestamp: endEasternUnix.toString(),
      start_eastern_time: formatEasternReadableTime(startDate),
      end_eastern_time: formatEasternReadableTime(endDate),
      
      // ADDITIONAL COMPATIBILITY FIELDS
      start_unix: startUnix,
      end_unix: endUnix,
      start_iso: startTimeISO,
      end_iso: endTimeISO,
      description: program.description,
      
      // Keep the original ISO timestamps for proper date comparison
      iso_start: program.start_time,
      iso_end: program.end_time,
      
      // Include data fields for debugging
      data_showname: program.data_showname,
      data_episodetitle: program.data_episodetitle,
      
      // Keep original index for debugging
      original_index: program.original_index
    };
  });
  
  console.log(`   ✅ Converted ${convertedPrograms.length} programs to EPGTask format`);
  
  // FILTER: Keep only today's and future programs using EPG year for date comparisons
  const todaysAndFuturePrograms = convertedPrograms.filter(program => {
    return isProgramTodayOrFuture(program, now, epgYear);
  });

  console.log(`   🎯 Today's and future programs: ${todaysAndFuturePrograms.length}`);
  console.log(`   🗑️  Yesterday/past programs filtered out: ${convertedPrograms.length - todaysAndFuturePrograms.length}`);

  // Apply time-of-day filtering to remove past programs from today
  const currentAndFuturePrograms = filterOutPastTodayPrograms(todaysAndFuturePrograms, now, epgYear);
  
  console.log(`   ⏰ Current and future programs (after time filtering): ${currentAndFuturePrograms.length}`);
  console.log(`   🗑️  Past today programs filtered out: ${todaysAndFuturePrograms.length - currentAndFuturePrograms.length}`);

  // Add real filtering debug to verify what's actually being filtered
  debugRealFiltering(convertedPrograms, currentAndFuturePrograms, now, epgYear);

  // Sort programs by start time (chronological order)
  const sortedPrograms = currentAndFuturePrograms.sort((a, b) => {
    const aStart = parseTimestamp(a.iso_start);
    const bStart = parseTimestamp(b.iso_start);
    return aStart - bStart;
  });

  // Log first few programs for debugging
  if (sortedPrograms.length > 0) {
    console.log(`   📋 Current and future programs (first 3):`);
    sortedPrograms.slice(0, 3).forEach((program, index) => {
      const startDate = new Date(program.iso_start);
      const endDate = new Date(program.iso_end);
      
      console.log(`     ${index + 1}. "${program.title}"`);
      console.log(`        Start: ${startDate.toLocaleString()}`);
      console.log(`        End:   ${endDate.toLocaleString()}`);
      console.log(`        UTC: ${program.start_utc}`);
      console.log(`        Local: ${program.start_time}`);
      console.log(`        Eastern: ${program.start_eastern_time}`);
      console.log(`        Eastern Unix: ${program.start_eastern_timestamp}`);
    });
  } else {
    console.log(`   ⚠️  No current or future programs found`);
  }

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

/* ================= PYTHON SCRAPER ================= */
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

// ============== NEW FUNCTION: RUN EPG3.PY UPDATER ==============
async function updateEpgData() {
  log("🔄 Starting EPG update...");
  
  return new Promise((resolve) => {
    // Check if epg3.py exists in data folder
    const epgScript = path.join(DATA_DIR, "epg3.py");
    if (!fs.existsSync(epgScript)) {
      log(`❌ EPG script not found: ${epgScript}`);
      resolve(false);
      return;
    }
    
    log(`📜 Running EPG updater: ${epgScript}`);
    const py = spawn("python", [epgScript]);
    
    py.stdout.on("data", d => {
      const output = d.toString().trim();
      log(`[EPG Update] ${output}`);
    });
    
    py.stderr.on("data", d => {
      const error = d.toString().trim();
      log(`[EPG Update Error] ${error}`);
    });
    
    py.on("close", (code) => {
      if (code === 0) {
        log("✅ EPG update completed successfully");
      } else {
        log(`❌ EPG update failed with code: ${code}`);
      }
      resolve(code === 0);
    });
    
    py.on("error", (err) => {
      log(`❌ Failed to start EPG updater: ${err.message}`);
      resolve(false);
    });
  });
}

// ============== FUNCTION TO CHECK AND RUN EPG UPDATE IF NEEDED ==============
async function checkAndUpdateEpg() {
  const lastUpdateFile = path.join(DATA_DIR, "last_epg_update.txt");
  const now = new Date();
  
  try {
    if (fs.existsSync(lastUpdateFile)) {
      const lastUpdateStr = fs.readFileSync(lastUpdateFile, "utf8").trim();
      const lastUpdate = new Date(lastUpdateStr);
      const daysSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60 * 24);
      
      if (daysSinceUpdate < EPG_UPDATE_DAYS) {
        log(`⏳ EPG update not needed yet. Last update: ${lastUpdate.toLocaleDateString()} (${daysSinceUpdate.toFixed(1)} days ago)`);
        return;
      }
    }
    
    log(`⏰ EPG update needed (every ${EPG_UPDATE_DAYS} days)`);
    await updateEpgData();
    
    // Update the last update timestamp
    fs.writeFileSync(lastUpdateFile, now.toISOString());
    log(`📝 Updated last EPG update timestamp: ${now.toISOString()}`);
    
  } catch (error) {
    log(`❌ Error checking EPG update: ${error.message}`);
  }
}

/* ================= UI ROUTES ================= */
uiApp.get("/", (req, res) => {
  const channels = fs.existsSync(CHANNELS_FILE)
    ? JSON.parse(fs.readFileSync(CHANNELS_FILE))
    : [];

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>IPTV Server</title>
<style>
body{font-family:Arial;background:#111;color:#eee;padding:20px}
.channel{padding:8px;border-bottom:1px solid #333}
button,select{margin:5px;padding:6px 10px}
#log{background:#000;padding:10px;height:400px;overflow:auto;margin-top:10px}
.epg-status {display:inline-block; margin-left:10px; padding:2px 8px; border-radius:3px; font-size:12px;}
.epg-up-to-date {background:#28a745; color:white;}
.epg-needs-update {background:#ffc107; color:black;}
</style>
</head>
<body>
<h1>📡 IPTV Server</h1>

<a href="/channel-list.json">Channels</a> |
<a href="/playlist.m3u">Playlist</a>

<br><br>

<button onclick="refreshAll()">🔁 Refresh ALL</button>
<button onclick="updateEPG()">📺 Update EPG</button>
<button onclick="clearLog()">🧹 Clear Log</button>

<br><br>

<select id="rollbackSelect">
<option value="">⏪ Rollback channels.json…</option>
</select>
<button onclick="rollback()">Restore</button>

<div id="epgStatus"></div>

<div id="log"></div>

${channels.map(c => `
<div class="channel">
${c.name}
<button onclick="refreshOne('${c.id}')">🔄</button>
</div>`).join("")}

<script>
const logDiv = document.getElementById("log");
const epgStatusDiv = document.getElementById("epgStatus");
const es = new EventSource("/events");
es.onmessage = e => {
  const msg = e.data;
  logDiv.innerHTML = msg + "<br>" + logDiv.innerHTML;
  
  // Update EPG status if mentioned in log
  if (msg.includes("EPG update")) {
    updateEpgStatus();
  }
};

function refreshAll() {
  fetch("/api/scraper/refresh", { method: "POST" });
}
function refreshOne(id) {
  fetch("/api/scraper/refresh/" + id, { method: "POST" });
}
function updateEPG() {
  if (confirm("Update EPG data from sources? This may take a few minutes.")) {
    fetch("/api/epg/update", { method: "POST" })
      .then(res => res.json())
      .then(data => {
        if (data.started) {
          alert("EPG update started! Check logs for progress.");
        }
      });
  }
}
function clearLog() { logDiv.innerHTML = ""; }

async function loadRollbackList() {
  const r = await fetch("/api/channels/rollback/list");
  const files = await r.json();
  const sel = document.getElementById("rollbackSelect");
  sel.innerHTML = '<option value="">⏪ Rollback channels.json…</option>';
  files.forEach(f => {
    const o = document.createElement("option");
    o.value = f;
    o.textContent = f;
    sel.appendChild(o);
  });
}

async function rollback() {
  const sel = document.getElementById("rollbackSelect");
  if (!sel.value) return;
  if (!confirm("Rollback to " + sel.value + "?")) return;
  await fetch("/api/channels/rollback/" + sel.value, { method: "POST" });
  loadRollbackList();
}

// Load EPG status
async function updateEpgStatus() {
  try {
    const response = await fetch("/api/epg/status");
    const data = await response.json();
    
    let statusHtml = \`<h3>📺 EPG Status</h3>\`;
    statusHtml += \`<p>Last update: \${data.lastUpdate ? new Date(data.lastUpdate).toLocaleString() : 'Never'}</p>\`;
    statusHtml += \`<p>Next update in: \${data.nextUpdateIn}</p>\`;
    statusHtml += \`<p>EPG files: \${data.epgFilesCount}</p>\`;
    
    if (data.needsUpdate) {
      statusHtml += \`<p class="epg-status epg-needs-update">⚠️ EPG update needed</p>\`;
    } else {
      statusHtml += \`<p class="epg-status epg-up-to-date">✅ EPG up to date</p>\`;
    }
    
    epgStatusDiv.innerHTML = statusHtml;
  } catch (error) {
    epgStatusDiv.innerHTML = \`<p>⚠️ Could not load EPG status</p>\`;
  }
}

loadRollbackList();
updateEpgStatus();
// Check EPG status every 5 minutes
setInterval(updateEpgStatus, 5 * 60 * 1000);
</script>
</body>
</html>`);
});

uiApp.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  sseClients.push(res);
  req.on("close", () => sseClients = sseClients.filter(c => c !== res));
});

uiApp.get("/channel-list.json", (req, res) => {
  res.json(fs.existsSync(CHANNELS_FILE)
    ? JSON.parse(fs.readFileSync(CHANNELS_FILE))
    : []);
});

uiApp.get("/playlist.m3u", (req, res) => {
  if (!fs.existsSync(CHANNELS_FILE)) {
    return res.send("#EXTM3U\n# No channels found");
  }

  const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE));
  const m3u = ["#EXTM3U"];

  channels.forEach(c => {
    m3u.push(`#EXTINF:-1 tvg-id="${c.id}" tvg-name="${c.name}" tvg-logo="${c.logo}",${c.name}`);
    m3u.push(c.url);
  });

  res.set("Content-Type", "audio/x-mpegurl");
  res.send(m3u.join("\n"));
});

/* ================= SCRAPER ROUTES (LOCAL) ================= */
uiApp.post("/api/scraper/refresh", async (req, res) => {
  await refreshChannels();
  res.json({ started: true });
});

uiApp.post("/api/scraper/refresh/:id", async (req, res) => {
  await refreshChannels(req.params.id);
  res.json({ started: true });
});

// ============== NEW ROUTE: UPDATE EPG ==============
uiApp.post("/api/epg/update", async (req, res) => {
  const success = await updateEpgData();
  res.json({ started: true, success });
});

// ============== NEW ROUTE: GET EPG STATUS ==============
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
        const daysLeft = EPG_UPDATE_DAYS - daysSinceUpdate;
        nextUpdateIn = `${daysLeft.toFixed(1)} days`;
      }
    }
  } catch (error) {
    // Ignore errors
  }
  
  // Count EPG files
  const epgFiles = fs.existsSync(EPG_DIR) 
    ? fs.readdirSync(EPG_DIR).filter(f => f.endsWith('.json')).length
    : 0;
  
  res.json({
    lastUpdate: lastUpdate ? lastUpdate.toISOString() : null,
    lastUpdateReadable: lastUpdate ? lastUpdate.toLocaleString() : "Never",
    needsUpdate,
    nextUpdateIn,
    epgFilesCount: epgFiles,
    updateFrequency: `${EPG_UPDATE_DAYS} days`,
    epgDir: EPG_DIR
  });
});

/* ================= API PROXY (FIXED) ================= */
uiApp.use("/api", async (req, res) => {
  try {
    const targetUrl =
      `http://localhost:${PORT_API}` +
      req.originalUrl.replace(/^\/api/, "");

    const r = await fetch(targetUrl, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: req.method === "GET" ? undefined : JSON.stringify(req.body)
    });

    const text = await r.text();
    res.status(r.status).send(text);
  } catch {
    res.status(500).send("API proxy error");
  }
});

/* ================= API SERVER ================= */
apiApp.get("/channel-list.json", (req, res) => {
  res.json(fs.existsSync(CHANNELS_FILE)
    ? JSON.parse(fs.readFileSync(CHANNELS_FILE))
    : []);
});

apiApp.get("/channels/rollback/list", (req, res) => {
  const files = fs.readdirSync(CHANNELS_BACKUP_DIR)
    .filter(f => f.startsWith("channels.") && f.endsWith(".json"))
    .sort()
    .reverse();
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

// ============== ADDED ROUTE FOR XML EPG URLs ==============
// This handles URLs like /channels/fox_news.json (from your XML files)
apiApp.get("/channels/:channel.json", (req, res) => {
  const requestedChannel = req.params.channel.replace('.json', '');
  
  console.log(`\n📡 EPG request: /channels/${requestedChannel}.json`);
  console.log(`   Current time: ${new Date().toISOString()}`);
  
  try {
    // Find matching EPG file
    const foundFile = findEpgFile(requestedChannel);
    
    if (!foundFile) {
      console.log(`❌ No EPG file found for: ${requestedChannel}`);
      return res.json({ 
        channel: requestedChannel, 
        programs: [] 
      });
    }
    
    console.log(`✅ Found EPG file: ${foundFile}`);
    
    // Load the EPG file
    const filePath = path.join(EPG_DIR, foundFile);
    const fileContent = fs.readFileSync(filePath, "utf8");
    const rawEpg = JSON.parse(fileContent);
    
    console.log(`   EPG file loaded (${fileContent.length} bytes)`);
    
    // Check the structure
    if (Array.isArray(rawEpg)) {
      console.log(`   EPG is a direct array with ${rawEpg.length} items`);
      if (rawEpg.length > 0) {
        console.log(`   First item keys: ${Object.keys(rawEpg[0]).join(', ')}`);
      }
    } else if (rawEpg.programs && Array.isArray(rawEpg.programs)) {
      console.log(`   EPG has programs array with ${rawEpg.programs.length} items`);
      if (rawEpg.programs.length > 0) {
        console.log(`   First program keys: ${Object.keys(rawEpg.programs[0]).join(', ')}`);
      }
    } else {
      console.log(`   EPG structure:`, JSON.stringify(rawEpg).slice(0, 200) + '...');
    }
    
    // Get filtered EPG data using your existing function
    const filteredEpg = getTodaysAndFutureEpgData(requestedChannel, rawEpg);
    
    console.log(`✅ Served EPG: ${requestedChannel} → ${foundFile}`);
    console.log(`   Original programs: ${Array.isArray(rawEpg) ? rawEpg.length : (rawEpg.programs ? rawEpg.programs.length : 0)}`);
    console.log(`   Filtered programs: ${filteredEpg.programs.length}`);
    
    // Show first few filtered programs
    if (filteredEpg.programs.length > 0) {
      console.log(`   First filtered program:`);
      console.log(`     Title: ${filteredEpg.programs[0].title}`);
      console.log(`     Start: ${filteredEpg.programs[0].start_time}`);
      console.log(`     End: ${filteredEpg.programs[0].end_time}`);
      console.log(`     UTC: ${filteredEpg.programs[0].start_utc}`);
      console.log(`     Eastern: ${filteredEpg.programs[0].start_eastern_time}`);
      console.log(`     Eastern Unix: ${filteredEpg.programs[0].start_eastern_timestamp}`);
    }
    
    res.json(filteredEpg);
    
  } catch (error) {
    console.log(`❌ EPG error: ${error.message}`);
    console.log(error.stack);
    res.json({ 
      channel: requestedChannel, 
      programs: [] 
    });
  }
});
// ============== END ADDED ROUTE ==============

/* ================= AUTO ================= */
if (AUTO_REFRESH_MIN > 0) {
  setInterval(refreshChannels, AUTO_REFRESH_MIN * 60000);
}

// Automatic rollback cleanup every 24 hours
setInterval(cleanupOldRollbacks, 24 * 60 * 60 * 1000); // 24 hours in ms
cleanupOldRollbacks(); // Run once immediately on server start

// ============== AUTO EPG UPDATE EVERY 3 DAYS ==============
// Check EPG update on server start
setTimeout(() => {
  checkAndUpdateEpg();
}, 10000); // Wait 10 seconds after server start

// Schedule EPG update check every 6 hours
setInterval(checkAndUpdateEpg, 6 * 60 * 60 * 1000); // 6 hours in ms

/* ================= START ================= */
uiApp.listen(PORT_UI, () => {
  log(`📡 UI http://localhost:${PORT_UI}`);
  log(`📺 EPG auto-update: Every ${EPG_UPDATE_DAYS} days`);
  log(`🔄 EPG check interval: Every 6 hours`);
});

apiApp.listen(PORT_API, () => log(`📡 API http://localhost:${PORT_API}`));