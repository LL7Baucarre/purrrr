"""
Geolocation module for IP address lookup using iplocate database
Uses free IP to Country and IP to ASN databases from https://github.com/iplocate/ip-address-databases
"""

import bisect
import ipaddress
import os
import requests
import csv
import zipfile
import io
from pathlib import Path
from functools import lru_cache

class ASNDatabase:
    """Handle IP to ASN (Autonomous System Number) lookups"""
    
    def __init__(self):
        self.ip_ranges = []
        self.loaded = False
        self.cache = {}
        self.load_database()
    
    def load_database(self):
        """Load IP to ASN database from local file or download it"""
        db_path = Path(__file__).parent / 'data' / 'ip_to_asn.csv'
        
        # Create data directory if it doesn't exist
        db_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Also check for file in parent directory (for Docker volume mounts)
        alt_path = Path(__file__).parent.parent.parent / 'ip-to-asn.csv'
        
        # Use whichever path has the file
        if alt_path.exists():
            db_path = alt_path
        
        # If file doesn't exist, try to download it
        if not db_path.exists():
            print(f"ASN database file not found at {db_path}. Downloading...")
            self._download_database(db_path)
        else:
            print(f"Using existing ASN database file: {db_path}")
        
        # Load the database
        if db_path.exists():
            self._load_csv(db_path)
            self.loaded = True
        else:
            print("Warning: IP to ASN database not found. ASN lookup will not be available.")
    
    def _download_database(self, db_path):
        """Download IP to ASN CSV from iplocate repo"""
        try:
            # Download the ZIP file containing the CSV
            url = "https://github.com/iplocate/ip-address-databases/raw/main/ip-to-asn/ip-to-asn.csv.zip"
            print(f"Downloading IP to ASN database from {url}...")
            response = requests.get(url, timeout=30)
            response.raise_for_status()
            
            # Extract CSV from ZIP
            with zipfile.ZipFile(io.BytesIO(response.content)) as zip_ref:
                # List files in the ZIP
                file_list = zip_ref.namelist()
                print(f"ZIP contents: {file_list}")
                
                # Find the CSV file (usually ip-to-asn.csv)
                csv_filename = None
                for filename in file_list:
                    if filename.endswith('.csv'):
                        csv_filename = filename
                        break
                
                if not csv_filename:
                    raise ValueError("No CSV file found in the ZIP archive")
                
                # Extract and save the CSV
                with zip_ref.open(csv_filename) as csv_file:
                    content = csv_file.read().decode('utf-8')
                    with open(db_path, 'w', encoding='utf-8') as f:
                        f.write(content)
            
            print(f"ASN database saved to {db_path}")
        except Exception as e:
            print(f"Error downloading ASN database: {e}")
    
    def _load_csv(self, db_path):
        """Load CSV database into memory with sorted arrays for binary search"""
        try:
            ranges = []
            with open(db_path, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    try:
                        network = ipaddress.ip_network(row['network'], strict=False)
                        ranges.append({
                            'start': int(network.network_address),
                            'end': int(network.broadcast_address),
                            'asn': row.get('asn', ''),
                            'as_name': row.get('as_name', ''),
                            'as_domain': row.get('as_domain', '')
                        })
                    except ValueError:
                        continue
            # Sort by start address for binary search
            ranges.sort(key=lambda x: x['start'])
            self._starts = [r['start'] for r in ranges]
            self._ends = [r['end'] for r in ranges]
            self._data = ranges
            self.ip_ranges = ranges  # Keep for compatibility
            print(f"Loaded {len(ranges)} IP ASN ranges (bisect-indexed)")
        except Exception as e:
            print(f"Error loading ASN database: {e}")
    
    def lookup(self, ip_address):
        """
        Lookup ASN for an IP address using binary search.
        Returns dict with asn, as_name, as_domain
        """
        if not ip_address or not self.loaded:
            return None
        
        # Check cache first
        if ip_address in self.cache:
            return self.cache[ip_address]
        
        try:
            ip_int = int(ipaddress.ip_address(ip_address.strip()))
            
            # Binary search: find the rightmost range whose start <= ip_int
            idx = bisect.bisect_right(self._starts, ip_int) - 1
            if idx >= 0 and ip_int <= self._ends[idx]:
                r = self._data[idx]
                result = {
                    'asn': r['asn'],
                    'as_name': r['as_name'],
                    'as_domain': r['as_domain']
                }
                self.cache[ip_address] = result
                return result
            
            self.cache[ip_address] = None
            return None
        except (ValueError, AttributeError):
            return None


class GeoLocationDB:
    """Handle IP to Country geolocation lookups"""
    
    def __init__(self):
        self.ip_ranges = []
        self.loaded = False
        self.cache = {}
        self.load_database()
    
    def load_database(self):
        """Load IP to Country database from local file or download it"""
        db_path = Path(__file__).parent / 'data' / 'ip_to_country.csv'
        
        # Create data directory if it doesn't exist
        db_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Also check for file in parent directory (for Docker volume mounts)
        alt_path = Path(__file__).parent.parent.parent / 'ip-to-country.csv'
        
        # Use whichever path has the file
        if alt_path.exists():
            db_path = alt_path
        
        # If file doesn't exist, try to download it
        if not db_path.exists():
            print(f"Database file not found at {db_path}. Downloading...")
            self._download_database(db_path)
        else:
            print(f"Using existing database file: {db_path}")
        
        # Load the database
        if db_path.exists():
            self._load_csv(db_path)
            self.loaded = True
        else:
            print("Warning: IP to Country database not found. Geolocation will not be available.")
    
    def _download_database(self, db_path):
        """Download IP to Country CSV from iplocate repo"""
        try:
            # Download the ZIP file containing the CSV
            url = "https://github.com/iplocate/ip-address-databases/raw/main/ip-to-country/ip-to-country.csv.zip"
            print(f"Downloading IP to Country database from {url}...")
            response = requests.get(url, timeout=30)
            response.raise_for_status()
            
            # Extract CSV from ZIP
            with zipfile.ZipFile(io.BytesIO(response.content)) as zip_ref:
                # List files in the ZIP
                file_list = zip_ref.namelist()
                print(f"ZIP contents: {file_list}")
                
                # Find the CSV file (usually ip-to-country.csv)
                csv_filename = None
                for filename in file_list:
                    if filename.endswith('.csv'):
                        csv_filename = filename
                        break
                
                if not csv_filename:
                    raise ValueError("No CSV file found in the ZIP archive")
                
                # Extract and save the CSV
                with zip_ref.open(csv_filename) as csv_file:
                    content = csv_file.read().decode('utf-8')
                    with open(db_path, 'w', encoding='utf-8') as f:
                        f.write(content)
            
            print(f"Database saved to {db_path}")
        except Exception as e:
            print(f"Error downloading database: {e}")
    
    def _load_csv(self, db_path):
        """Load CSV database into memory with sorted arrays for binary search"""
        try:
            ranges = []
            with open(db_path, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    try:
                        network = ipaddress.ip_network(row['network'], strict=False)
                        ranges.append({
                            'start': int(network.network_address),
                            'end': int(network.broadcast_address),
                            'continent_code': row.get('continent_code', ''),
                            'country_code': row.get('country_code', ''),
                            'country_name': row.get('country_name', '')
                        })
                    except ValueError:
                        continue
            # Sort by start address for binary search
            ranges.sort(key=lambda x: x['start'])
            self._starts = [r['start'] for r in ranges]
            self._ends = [r['end'] for r in ranges]
            self._data = ranges
            self.ip_ranges = ranges  # Keep for compatibility
            print(f"Loaded {len(ranges)} IP ranges (bisect-indexed)")
        except Exception as e:
            print(f"Error loading database: {e}")
    
    def lookup(self, ip_address):
        """
        Lookup geolocation for an IP address using binary search.
        Returns dict with country_code, country_name, continent_code
        """
        if not ip_address or not self.loaded:
            return None
        
        # Check cache first
        if ip_address in self.cache:
            return self.cache[ip_address]
        
        try:
            ip_int = int(ipaddress.ip_address(ip_address.strip()))
            
            # Binary search: find the rightmost range whose start <= ip_int
            idx = bisect.bisect_right(self._starts, ip_int) - 1
            if idx >= 0 and ip_int <= self._ends[idx]:
                r = self._data[idx]
                result = {
                    'country_code': r['country_code'],
                    'country_name': r['country_name'],
                    'continent_code': r['continent_code']
                }
                self.cache[ip_address] = result
                return result
            
            self.cache[ip_address] = None
            return None
        except (ValueError, AttributeError):
            return None
    
    def get_flag_emoji(self, country_code):
        """Convert country code to flag emoji"""
        if not country_code or len(country_code) != 2:
            return ''
        
        # Convert country code to flag emoji
        return ''.join(chr(0x1F1E6 + ord(c) - ord('A')) for c in country_code.upper())


# Global instances
_geo_db = None
_asn_db = None

def get_geolocation_db():
    """Get or create the geolocation database instance"""
    global _geo_db
    if _geo_db is None:
        _geo_db = GeoLocationDB()
    return _geo_db

def get_asn_db():
    """Get or create the ASN database instance"""
    global _asn_db
    if _asn_db is None:
        _asn_db = ASNDatabase()
    return _asn_db

def are_databases_ready():
    """Check if both databases are loaded"""
    geo_db = get_geolocation_db()
    asn_db = get_asn_db()
    return geo_db.loaded and asn_db.loaded

def lookup_ip(ip_address):
    """Lookup IP geolocation"""
    db = get_geolocation_db()
    return db.lookup(ip_address)

def lookup_asn(ip_address):
    """Lookup ASN for IP address"""
    db = get_asn_db()
    return db.lookup(ip_address)

def precache_ips(ip_set: set):
    """Pre-cache all unique IPs in one pass. Call this before processing rows.
    
    This avoids repeated lookups for the same IP during row-by-row processing.
    With bisect, each lookup is O(log n) so this is fast even for large sets.
    """
    geo_db = get_geolocation_db()
    asn_db = get_asn_db()
    cached = 0
    for ip in ip_set:
        if ip and isinstance(ip, str) and ip.strip():
            ip_clean = ip.strip()
            if ip_clean not in geo_db.cache:
                geo_db.lookup(ip_clean)
            if ip_clean not in asn_db.cache:
                asn_db.lookup(ip_clean)
            cached += 1
    print(f"🔍 Pre-cached {cached} unique IPs for geo/ASN lookup")

def get_ip_display(ip_address):
    """Get formatted IP display with country info"""
    db = get_geolocation_db()
    result = db.lookup(ip_address)
    
    if result:
        flag = db.get_flag_emoji(result['country_code'])
        return f"{ip_address} {flag} {result['country_name']}"
    
    return ip_address
