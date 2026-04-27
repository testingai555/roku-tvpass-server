# Patch Tool – Update IP & Port in Zipped Configuration

This tool applies a patch to a configuration file inside a given ZIP archive, updating the server IP address and port number.

## 📦 What it does

- Takes a ZIP file as input
- Extracts a specific file (e.g., `config.xml`, `.env`, or `settings.json`)
- Finds and replaces the old IP address and port
- Repackages the modified file back into the ZIP archive

## 🚀 Usage
python patchruko.py
and then follow prompts ipaddress of server should be local ip on lan 
and then port port can be changed in the server.js make sure they match default 8081

