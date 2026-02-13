import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";

const PORT = 8082;
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");

const app = express();
app.use(cors());

/* Serve entire data directory if you want */
app.use("/data", express.static(DATA_DIR));

/* Explicit endpoint (recommended) */
app.get("/channels.json", (req, res) => {
  if (!fs.existsSync(CHANNELS_FILE)) {
    return res.status(404).json([]);
  }
  res.sendFile(CHANNELS_FILE);
});

app.listen(PORT, () => {
  console.log(`📂 channels.json available at http://localhost:${PORT}/channels.json`);
});
