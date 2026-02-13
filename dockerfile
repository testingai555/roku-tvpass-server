# === Base image with Node 24 ===
FROM node:24-bookworm

# === Install system dependencies + Python 3.11 ===
RUN apt-get update && apt-get install -y \
    python3.11 \
    python3.11-venv \
    python3-pip \
    cron \
    wget \
    unzip \
    curl \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcups2 \
    libxss1 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

# Make python3 point to python3.11
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# === Install Google Chrome (modern method, no apt-key) ===
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-linux.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux.gpg] \
    http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list && \
    apt-get update && \
    apt-get install -y google-chrome-stable && \
    rm -rf /var/lib/apt/lists/*

# === Environment ===
ENV TZ=America/New_York
ENV PORT=8081
WORKDIR /app

# === Copy files ===
COPY package*.json ./
COPY . .

# === Install Node dependencies ===
RUN npm ci --omit=dev

# === Create Python virtual environment ===
RUN python3 -m venv /app/venv
ENV PATH="/app/venv/bin:$PATH"

# === Install Python dependencies ===
RUN pip install --no-cache-dir \
    selenium \
    requests \
    playwright \
    webdriver-manager

# === Install Playwright browsers ===
RUN playwright install --with-deps chromium

# === Setup Cron Jobs ===
RUN echo "*/30 * * * * cd /app && /app/venv/bin/python3 fetch_epg5.py >> /var/log/cron.log 2>&1" \
    > /etc/cron.d/fetchjob && \
    echo "0 0 */2 * * cd /app && /app/venv/bin/python3 epg3.py >> /var/log/cron.log 2>&1" \
    > /etc/cron.d/epg3job && \
    chmod 0644 /etc/cron.d/fetchjob /etc/cron.d/epg3job && \
    crontab /etc/cron.d/fetchjob && \
    crontab -l | cat - /etc/cron.d/epg3job | crontab -

# === Start Script ===
RUN printf '#!/bin/bash\n\
set -e\n\
service cron start\n\
touch /var/log/cron.log\n\
chmod 666 /var/log/cron.log\n\
cd /app\n\
node server.js &\n\
tail -f /var/log/cron.log\n' > /start.sh \
&& chmod +x /start.sh

EXPOSE 8081
CMD ["/bin/bash", "/start.sh"]
