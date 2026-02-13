#!/bin/bash

echo "🚀 Starting background Python services..."



# Run channel_logos.py once at startup
echo "🎨 Running channel_logos.py..."
python3 channel_logos.py &

# Run epg3.py once at startup
python3 epg3.py &

# Start repeating fetch_epg5.py every 30 minutes
(
  while true
  do
    echo "🕒 Running fetch_epg5.py..."
    python3 fetch_epg5.py
    echo "✅ fetch_epg5.py finished. Sleeping for 30 minutes..."
    sleep 1800  # 30 minutes = 1800 seconds
  done
) &

# Start repeating epg3.py every 32 hours
(
  while true
  do
    echo "⏰ Running epg3.py..."
    python3 epg3.py
    echo "✅ epg3.py finished. Sleeping for 32 hours..."
    sleep 115200  # 32 hours = 115200 seconds
  done
) &

echo "🌐 Starting Node.js server..."
# Run Node.js server in foreground (keeps container alive)
node server.js
