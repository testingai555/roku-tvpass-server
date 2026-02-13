import zipfile
import os
import re
import tempfile
import shutil

def patch_zip_file(zip_path, new_ip):
    """
    Patches the ZIP file by replacing rokuapp.myddns.me with user-provided IP
    in Config.brs and RowListContentTask.xml files
    """
    
    # Create a temporary directory to extract and modify files
    with tempfile.TemporaryDirectory() as temp_dir:
        # Extract the entire zip to temporary directory
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)
        
        # Patch Config.brs
        config_path = os.path.join(temp_dir, 'components', 'Config.brs')
        if os.path.exists(config_path):
            with open(config_path, 'r', encoding='utf-8') as file:
                content = file.read()
            
            # Replace the domain with new IP in both lines
            # This pattern will match both the original domain and any IP address that might be there
            content = re.sub(
                r'jsonUrl\s*=\s*"http://[^:]+:8081/channel-list\.json"',
                f'jsonUrl = "http://{new_ip}:8081/channel-list.json"',
                content
            )
            content = re.sub(
                r'channel\.epgUrl\s*=\s*"http://[^:]+:8081/channels/"\s*\+\s*channel\.id\s*\+\s*"\.json"',
                f'channel.epgUrl = "http://{new_ip}:8081/channels/" + channel.id + ".json"',
                content
            )
            
            with open(config_path, 'w', encoding='utf-8') as file:
                file.write(content)
            print(" Patched Config.brs")
        else:
            print(" Config.brs not found")
        
        # Patch RowListContentTask.xml
        rowlist_path = os.path.join(temp_dir, 'components', 'tasks', 'RowListContentTask.xml')
        if os.path.exists(rowlist_path):
            with open(rowlist_path, 'r', encoding='utf-8') as file:
                content = file.read()
            
            # Replace all occurrences of rokuapp.myddns.me with new IP
            # Also handle cases where it might already be an IP
            content = re.sub(r'rokuapp\.myddns\.me|\d+\.\d+\.\d+\.\d+', new_ip, content)
            
            with open(rowlist_path, 'w', encoding='utf-8') as file:
                file.write(content)
            print(" Patched RowListContentTask.xml")
        else:
            print(" RowListContentTask.xml not found")
        
        # Create a new zip file with the modified content
        base_name = os.path.splitext(zip_path)[0]
        new_zip_path = f"{base_name}_patched.zip"
        
        with zipfile.ZipFile(new_zip_path, 'w', zipfile.ZIP_DEFLATED) as new_zip:
            for root, dirs, files in os.walk(temp_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    # Calculate the relative path for the zip
                    relative_path = os.path.relpath(file_path, temp_dir)
                    new_zip.write(file_path, relative_path)
        
        print(f" Created patched zip: {new_zip_path}")
        return new_zip_path

def main():
    print("Roku ZIP Patcher")
    print("================")
    
    # Get user input
    zip_file = input("Enter the path to the ZIP file: ").strip()
    
    if not os.path.exists(zip_file):
        print("Error: ZIP file not found!")
        return
    
    new_ip = input("Enter the new IP address: ").strip()
    
    if not new_ip:
        print("Error: IP address cannot be empty!")
        return
    
    try:
        patched_zip = patch_zip_file(zip_file, new_ip)
        print(f"\nPatch completed successfully!")
        print(f"Original file: {zip_file}")
        print(f"Patched file: {patched_zip}")
        
    except Exception as e:
        print(f"Error during patching: {str(e)}")

if __name__ == "__main__":
    main()
