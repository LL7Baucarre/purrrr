# purrrr

A powerful command-line tool and web application for analyzing Microsoft Purview audit logs and Entra sign-ins. Extract insights from SharePoint, OneDrive, Exchange activity, and user authentication with comprehensive filtering, security analysis, and detailed reporting.

**Available in two modes:**
- **CLI**: Command-line analysis with JSON and formatted text output
- **Web UI**: Flask-based web interface with Redis session management (Docker-ready)

## Features

### File Operations Analysis

- **File Activity Tracking**: Analyze downloads, uploads, deletions, and other file operations
- **Path Analysis**: Track access patterns across SharePoint sites and OneDrive folders
- **Bulk Operations Detection**: Identify suspicious mass downloads or deletions
- **File Timeline**: Generate chronological timelines of file access events
- **URL Export**: Export full SharePoint/OneDrive URLs for accessed files

### User Activity Insights

- **User Mapping**: Map user emails to display names via CSV import
- **Activity Filtering**: Filter analysis by specific users or user groups
- **Top Users**: Identify most active users by operation type
- **User Statistics**: Detailed breakdown of user activity patterns

### Security Analysis

- **IP Address Analysis**: Track and analyze source IP addresses with optional geolocation lookup
- **User Agent Detection**: Identify unusual or suspicious client applications
- **Suspicious Pattern Detection**: Flag bulk operations, unusual access patterns, and after-hours activity
- **Network Filtering**: Filter by specific IP addresses or exclude known good IPs

### Exchange Activity

- **Email Operations**: Track email sends, moves, deletions, and rule changes
- **Mailbox Access**: Monitor folder access and email reading patterns
- **Client Application Tracking**: Identify which applications accessed Exchange
- **Detailed Email Analysis**: Extract subjects, senders, recipients, and attachments
- **CSV Export**: Export complete Exchange activity to CSV for further analysis

### Advanced Filtering

- **Date Range**: Filter analysis to specific time periods
- **Action Types**: Focus on specific operations (downloads, uploads, etc.)
- **File Keywords**: Search for files containing specific keywords
- **IP Filtering**: Include or exclude specific IP addresses with wildcard support

### Sign-in Analysis (from Entra ID sign-in logs)

- **Authentication Tracking**: Analyze user sign-ins from Microsoft Entra audit logs
- **Failure Detection**: Identify failed sign-ins and authentication errors
- **Device Analysis**: Track device types, operating systems, and client applications
- **Location Monitoring**: Analyze sign-in locations and IP addresses
- **Security Insights**: Detect unusual sign-in patterns and potential security issues

## Arguments

### Purview Log Analysis for SharePoint and Exchange

```text
--actions ACTIONS                     specific actions to analyze, comma-separated
--list-files KEYWORD                  list filenames containing keyword
--list-actions-for-files KEYWORD      list actions performed on files by keyword
--user USERNAME                       filter actions by specific user
--user-map USER_MAP_CSV               optional M365 user export CSV (UPN, display name)
--start-date START_DATE               start date for analysis (YYYY-MM-DD)
--end-date END_DATE                   end date for analysis (YYYY-MM-DD)
--sort-by {filename,username,date}    sort results by filename, username, or date (default: date)
--details                             show detailed file lists in operation summaries
--ips IPS                             filter by individual IPs (comma-separated, supports wildcards)
--exclude-ips IPS                     exclude specific IPs (comma-separated, supports wildcards)
--do-ip-lookups                       perform IP geolocation lookups (takes a few seconds per IP)
--timeline                            print a full timeline of file access events
--full-urls                           print full URLs of accessed files
--exchange                            output only Exchange activity in table format
--export-exchange-csv OUTPUT_FILE     export Exchange activity to specified CSV file
```

### Entra ID Log Analysis for Sign-In Activity

```text
--entra                               analyze sign-in data from an Entra ID CSV audit log
--filter FILTER_TEXT                  filter sign-ins by specified text (case-insensitive)
--exclude EXCLUDE_TEXT                exclude sign-ins with specified text (case-insensitive)
--limit MAX_ROWS                      limit rows shown for each sign-in column
```

### Output Format

```text
--text                                output formatted text instead of JSON (default is JSON)
```

**Note**: purrrr outputs results as **JSON by default** for easy integration with scripts and tools. Use `--text` to get the traditional colored, formatted output.

## Usage

### CLI Mode (Local or Docker)

#### Full Comprehensive Analysis

```bash
# Analyze all file operations from a Purview audit log (outputs JSON)
purrrr audit_log.csv

# Get formatted text output instead
purrrr audit_log.csv --text

# Analyze Entra ID sign-in data (outputs JSON)
purrrr signin_data.csv --entra
```

### Common Workflows

#### Security Investigation

```bash
# Look for suspicious bulk downloads (JSON output)
purrrr audit_log.csv --actions "FileDownloaded" --details

# With formatted text output
purrrr audit_log.csv --actions "FileDownloaded" --details --text

# Analyze IP addresses with geolocation
purrrr audit_log.csv --do-ip-lookups

# Check specific user's activity
purrrr audit_log.csv --user "john.doe@company.com" --timeline
```

#### File Discovery

```bash
# Find files containing sensitive keywords
purrrr audit_log.csv --list-actions-for-files "confidential"

# Export all accessed file URLs
purrrr audit_log.csv --full-urls
```

#### Exchange Analysis

```bash
# Focus on email activity only (JSON output)
purrrr audit_log.csv --exchange

# Export Exchange data for further analysis
purrrr audit_log.csv --export-exchange-csv email_activity.csv
```

#### Sign-in Analysis

```bash
# Filter sign-ins by specific criteria
purrrr signin_data.csv --entra --filter "admin" --exclude "success"
```

#### JSON Processing

```bash
# Parse JSON output with jq
purrrr audit_log.csv | jq '.total_operations'

# Extract specific data from results
purrrr audit_log.csv | jq '.operations_by_user'

# Programmatic integration
python_script.py $(purrrr audit_log.csv | jq '.summary')
```

## Installation

### Option 1: Local Installation (CLI Only)

```bash
pip install purrrr
```

### Option 2: Docker (Recommended for Web UI)

#### Prerequisites

- Docker and Docker Compose installed
- For M365 audit log analysis, export CSV files from Microsoft Purview

#### Quick Start with Docker Compose

```bash
# Clone or download the project
cd purrrr

# Build and start services (Flask web app + Redis)
docker-compose up --build

# Access the web interface at http://localhost:5000
```

The docker-compose setup includes:
- **Redis 7** (Alpine): Session and cache management (2GB max memory)
- **purrrr Web App**: Flask application on port 5000 with health checks

#### Docker Environment Variables

Edit `docker-compose.yml` before deployment:

```yaml
environment:
  - FLASK_ENV=production              # Set to 'development' for debug mode
  - REDIS_URL=redis://redis:6379/0   # Redis connection (default)
  - UPLOAD_FOLDER=/tmp/purrrr         # Temporary upload directory
  - MAX_FILE_SIZE=500                 # Max file size in MB
  - SECRET_KEY=your-secret-key        # CHANGE THIS FOR PRODUCTION
```

#### Running Web App Standalone (Without Docker)

```bash
# Install dependencies
pip install -r requirements.txt

# Run Flask app locally (requires Redis or uses filesystem fallback)
python run_web.py --host 0.0.0.0 --port 5000 --debug
```

#### Docker Build Customization

Build the image manually:

```bash
docker build -t purrrr:latest .
docker run -p 5000:5000 \
  -e REDIS_URL=redis://your-redis-host:6379/0 \
  -e SECRET_KEY=your-secret-key \
  -v /path/to/logs:/app/logs \
  purrrr:latest
```

#### Production Deployment Tips

1. **Change SECRET_KEY**: Update `SECRET_KEY` in docker-compose.yml to a random string
2. **Configure Redis**: Use external Redis for scaling (set `REDIS_URL` env var)
3. **Volume Management**: Mount persistent volumes for logs and uploads:
   ```bash
   -v /secure/path/logs:/app/logs
   -v /secure/path/uploads:/tmp/purrrr
   ```
4. **Health Checks**: Endpoints checked every 30s; configure `HEALTHCHECK` in docker-compose.yml
5. **Reverse Proxy**: Use Nginx/Traefik in front of the Flask app for SSL/TLS

## Requirements

- **Python 3.13+**
- **Docker & Docker Compose** (for web UI deployment)
- **Microsoft Purview audit log CSV export** (for SharePoint/Exchange analysis)
- **Microsoft Entra sign-ins CSV export** (for sign-in analysis, optional)

**Important Note**: The sign-in analysis feature uses a different data source than the main Purview analysis. While most features analyze data from Microsoft Purview audit logs (SharePoint, OneDrive, Exchange), the `--entra` feature specifically requires a CSV export from Microsoft Entra ID's sign-in logs. These are two separate data sources with different formats and column structures.

The tool automatically detects SharePoint domains and email domains from your audit data, making it work seamlessly with any Microsoft 365 tenant.

## Architecture

### Web UI Architecture (Docker)

```
┌─────────────────────────────────────────────────────────┐
│                   Docker Environment                     │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ┌──────────────────┐        ┌──────────────────┐       │
│  │  Flask Web App   │◄──────►│  Redis Session   │       │
│  │  (Port 5000)     │        │  Cache (Port     │       │
│  │  - Upload        │        │  6379)           │       │
│  │  - Analysis      │        │  - User Sessions │       │
│  │  - JSON API      │        │  - File Uploads  │       │
│  └──────────────────┘        └──────────────────┘       │
│         ▲                                                 │
│         │ HTTP                                           │
└─────────┼─────────────────────────────────────────────────┘
          │
     Browser (localhost:5000)
```

### CLI Architecture

Direct Python execution with command-line arguments, no web server required.

## License

purrrr is released under the MIT License. See the LICENSE file for details.
