import json
import logging
import time
import os
import concurrent.futures
from queue import Queue
from threading import Lock

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

logging.basicConfig(
    level=logging.INFO,
    format="[%(levelname)s] %(message)s"
)

DATA_DIR = os.path.join(os.getcwd(), "data")
CHANNELS_FILE = os.path.join(DATA_DIR, "channels.json")
AS_FILE = os.path.join(DATA_DIR, "as.json")

# ---------------- Chrome Pool ----------------
class ChromePool:
    def __init__(self, size=2):
        self.size = size
        self.pool = Queue()
        self.lock = Lock()
        for _ in range(size):
            driver = self._create_driver()
            self.pool.put(driver)

    def _create_driver(self):
        chrome_options = Options()
        chrome_options.add_argument("--headless=new")
        chrome_options.add_argument("--mute-audio")
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-shm-usage")
        chrome_options.add_argument("--disable-gpu")
        chrome_options.add_argument("--disable-notifications")
        chrome_options.page_load_strategy = 'eager'
        prefs = {"profile.managed_default_content_settings.images": 2}
        chrome_options.add_experimental_option("prefs", prefs)
        chrome_options.set_capability("goog:loggingPrefs", {"performance": "ALL"})
        service = Service()
        driver = webdriver.Chrome(service=service, options=chrome_options)
        driver.set_page_load_timeout(20)
        return driver

    def get_driver(self):
        return self.pool.get()

    def return_driver(self, driver):
        self.pool.put(driver)

    def close_all(self):
        while not self.pool.empty():
            driver = self.pool.get()
            try:
                driver.quit()
            except:
                pass

# ---------------- Helpers ----------------
def extract_m3u8_urls(driver, wait_time=10):
    start_time = time.time()
    while time.time() - start_time < wait_time:
        logs = driver.get_log("performance")
        for log in logs:
            try:
                msg = json.loads(log["message"])
                method = msg["message"].get("method", "")
                if "Network.requestWillBeSent" in method:
                    req_url = msg["message"]["params"]["request"]["url"]
                    if ".m3u8" in req_url and "thetvapp.to" in req_url:
                        return req_url
            except Exception:
                continue
        time.sleep(0.5)
    return None

def get_m3u8_url(channel, pool: ChromePool, retry_count=0):
    name = channel.get("channel", "Unknown")
    url = channel.get("url", "")
    logo = channel.get("thumb", "")
    driver = None
    try:
        driver = pool.get_driver()
        logging.info(f"🔄 RETRY {retry_count}: {url}" if retry_count else f"🌐 Loading: {url}")
        driver.get(url)
        try:
            wait = WebDriverWait(driver, 5)
            video_element = wait.until(
                EC.presence_of_element_located((By.CSS_SELECTOR, "video, .play-button, [aria-label*='play' i]"))
            )
            if video_element.is_displayed():
                video_element.click()
                logging.info(f"▶️ Clicked play button for {name}")
                time.sleep(1)
        except Exception:
            logging.warning(f"⚠️ {name}: Video/play button not found")

        m3u8_url = extract_m3u8_urls(driver, 10)
        if m3u8_url:
            logging.info(f"✅ {name} → {m3u8_url}")
            return {"id": name, "name": name, "url": m3u8_url, "logo": logo, "success": True}
        logging.warning(f"❌ {name}: No m3u8 URL found")
        return {"id": name, "name": name, "url": None, "logo": logo, "success": False, "original_channel": channel}
    except Exception as e:
        logging.error(f"💥 {name}: {e}")
        return {"id": name, "name": name, "url": None, "logo": logo, "success": False, "original_channel": channel, "error": str(e)}
    finally:
        if driver:
            pool.return_driver(driver)

# ---------------- Main ----------------
def main():
    if not os.path.exists(AS_FILE):
        logging.error("❌ as.json not found!")
        return

    with open(AS_FILE, "r") as f:
        channels = json.load(f)

    existing_data = []
    if os.path.exists(CHANNELS_FILE):
        with open(CHANNELS_FILE, "r") as f:
            try:
                existing_data = json.load(f)
            except json.JSONDecodeError:
                logging.warning("⚠️ channels.json invalid — starting fresh")

    existing_dict = {ch.get("id") or ch.get("name"): ch for ch in existing_data}
    start_time = time.time()

    pool = ChromePool(size=2)  # Keep 2 Chrome instances running
    all_results = []
    failed_channels = []

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(get_m3u8_url, ch, pool) for ch in channels]
            for future in concurrent.futures.as_completed(futures):
                result = future.result()
                all_results.append(result)
                if not result.get("success"):
                    failed_channels.append(result)

        # Retry failed
        if failed_channels:
            logging.info(f"🔄 Retrying {len(failed_channels)} failed channels...")
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                futures = [
                    executor.submit(get_m3u8_url, r.get("original_channel"), pool, retry_count=1)
                    for r in failed_channels if r.get("original_channel")
                ]
                for future in concurrent.futures.as_completed(futures):
                    result = future.result()
                    all_results = [result if r.get("id") == result.get("id") else r for r in all_results]

    finally:
        pool.close_all()  # Close all Chrome instances

    # Update channels.json in data/
    updated_count = 0
    for ch in [r for r in all_results if r.get("success")]:
        key = ch.get("id")
        if key in existing_dict:
            old_url = existing_dict[key].get("url")
            if old_url != ch["url"]:
                existing_dict[key]["url"] = ch["url"]
                updated_count += 1
        else:
            existing_dict[key] = ch
            updated_count += 1

    updated_list = list(existing_dict.values())
    with open(CHANNELS_FILE, "w") as f:
        json.dump(updated_list, f, indent=2)

    logging.info(f"🔄 Updated {updated_count} channels in {CHANNELS_FILE}")
    logging.info(f"⏱️ Total time: {time.time()-start_time:.2f} seconds")

if __name__ == "__main__":
    main()
