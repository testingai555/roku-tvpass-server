

if you find this usefull and would like to donate to help 
https://gofund.me/ff637712a 


📺 IPTV Server with EPG & Stream Control
A comprehensive IPTV server solution with automatic EPG (Electronic Program Guide) management, channel scheduling, and stream control capabilities for audio transcription services.

📋 Features
Channel Management: Automatic channel scraping and refresh every 120 minutes

EPG Integration: XMLTV-compatible EPG with automatic updates every 3 days

Stream Control: Remote stream management for audio transcription/processing services

Backup & Rollback: Automatic backup of channel configurations with 24-hour retention

Real-time Logging: SSE (Server-Sent Events) for live log streaming

Multiple Formats: Support for M3U playlists and JSON channel lists

Eastern Time Support: Automatic timezone conversion for EPG data

Smart EPG Filtering: Only shows current and future programs, filters out past content

Automatic File Mapping: Smart channel name matching for EPG files

🚀 Installation
Prerequisites
Node.js (v14 or higher)

Python 3.x

npm or yarn

Setup
Clone the repository:

bash
git clone https://github.com/yourusername/iptv-server.git
cd iptv-server
Install dependencies:

bash
npm install express cors
Ensure Python scripts are present:

fetch_epg5.py - For channel scraping

epg3.py - For EPG data updates

Start the server:

bash
node server.js
The server will start two services:

UI Server: http://localhost:3000

API Server: http://localhost:8081

📁 Project Structure
text
iptv-server/
├── data/
│   ├── as.json                 # Channel data
│   ├── channels.json            # Main channel configuration
│   ├── channels.backups/        # Automatic backups
│   └── epg/                     # EPG JSON files
├── fetch_epg5.py                 # Channel scraper
├── epg3.py                       # EPG updater
└── server.js                     # Main server file
🔧 Configuration
Edit the configuration section at the top of server.js:

javascript
const PORT_UI = 3000;           // UI server port
const PORT_API = 8081;           // API server port
const AUTO_REFRESH_MIN = 120;    // Channel refresh interval (minutes)
const EPG_UPDATE_DAYS = 3;       // EPG update frequency (days)
📡 API Endpoints
UI Server (Port 3000)
Endpoint	Method	Description
/	GET	Web UI dashboard
/events	GET	SSE log stream
/channel-list.json	GET	JSON channel list
/playlist.m3u	GET	M3U playlist
/api/scraper/refresh	POST	Refresh all channels
/api/scraper/refresh/:id	POST	Refresh specific channel
/api/epg/update	POST	Trigger EPG update
/api/epg/status	GET	EPG update status
/api/start-stream/:channelId	POST	Start stream for transcription
API Server (Port 8081)
Endpoint	Method	Description
/channel-list.json	GET	JSON channel list
/channels/rollback/list	GET	List available rollbacks
/channels/rollback/:file	POST	Restore from backup
/channels/:channel.json	GET	Get EPG data for channel
🎯 EPG Features
Smart Channel Matching
The server automatically matches channel names to EPG files using multiple strategies:

Exact filename matching

Case-insensitive matching

Space/underscore/hyphen variations

Common abbreviations (e.g., "A&E" → "ae")

Contains matching

Timezone Handling
Automatic conversion to Eastern Time (America/New_York)

DST (Daylight Saving Time) support

Multiple timestamp format support:

Unix timestamps (seconds/milliseconds)

ISO 8601 strings

Custom date formats

Program Filtering
Only shows current and future programs

Filters out past programs from today

Maintains chronological order

Handles programs that span midnight

🎙️ Stream Control for Transcription
The server includes a stream control feature designed to interface with audio transcription services. When a stream is started, it sends a request to a transcription server that can:

Begin capturing audio from the specified stream

Process the audio for transcription/speech-to-text

Generate real-time captions or transcripts

Archive audio for later processing

How It Works
User clicks "Start Stream" for a channel in the web UI

Server sends a curl command to the transcription service:

bash
curl -X POST http://10.0.0.199:5000/start-stream \
  -H "Content-Type: application/json" \
  -d '{"url": "STREAM_URL", "session_id": "CHANNEL_ID"}'
Transcription service begins processing the audio stream

Logs show the command execution and any responses

Transcription Service Integration
The stream control endpoint is designed to work with a separate transcription service that:

Listens on port 5000 at IP 10.0.0.199 (configurable)

Accepts stream URLs and session IDs

Returns status of the transcription job

Manages multiple concurrent transcription sessions

This separation allows:

Dedicated processing for audio transcription

Scalable architecture

Independent development of transcription features

Easy replacement with different transcription backends

🖥️ Web UI
The web interface provides:

Channel list with refresh buttons

EPG update status indicator

Real-time log viewer

Stream control buttons for transcription

Rollback management

Clear log functionality

🔄 Automatic Processes
Channel Refresh: Every 120 minutes (configurable)

EPG Update: Every 3 days (configurable)

Backup Cleanup: Every 24 hours (deletes backups older than 24 hours)

EPG Status Check: Every 6 hours

📦 Backup System
Automatic backups before each channel refresh

Backups stored in data/channels.backups/

Filename format: channels.YYYY-MM-DDTHH-MM-SS-msZ.json

Automatic cleanup after 24 hours

Manual rollback available via UI/API

📝 Logging
Real-time logs via SSE

Log rotation (keeps last 1000 entries)

Timestamped entries

Color-coded console output

Web UI log viewer

Transcription command execution logs

🛠️ Development
Adding New EPG Sources
Place EPG JSON files in data/epg/

Ensure files follow expected format:

json
[
  {
    "title": "Program Name",
    "start_time": "timestamp",
    "end_time": "timestamp",
    "description": "..."
  }
]
Custom Channel Mappings
Edit the epgFileMappings object in server.js for manual overrides:

javascript
const epgFileMappings = {
    "Custom Channel Name": "filename.json",
    // ...
};
Configuring Transcription Service
To connect to a different transcription server, modify the IP address in the curl command:

javascript
// In server.js, find and modify:
const curlCommand = `curl -X POST http://YOUR_SERVER_IP:5000/start-stream ...`;
🐛 Troubleshooting
Common Issues
EPG files not loading

Check file permissions

Verify JSON format

Check console logs for file matching

Stream start failures

Verify transcription server IP and port

Check if transcription service is running

Verify URL escaping

Review curl command in logs

Time zone issues

Verify system timezone settings

Check DST handling

Review timestamp parsing logs

Debug Mode
Enable detailed logging by checking:

Program parsing logs

Date filtering verification

EPG file matching attempts

Curl command execution

🤝 Contributing
Contributions are welcome! Please:

Fork the repository

Create a feature branch

Commit your changes

Push to the branch

Open a Pull Request

📄 License
MIT License - feel free to use and modify for your own projects.

⚠️ Disclaimer
This software is for educational purposes.

🙏 Acknowledgments
Built with Express.js

EPG handling inspired by XMLTV format

Timezone handling using JavaScript Intl API

Stream control designed for transcription service integratio

