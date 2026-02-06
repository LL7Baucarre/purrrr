# purrrr

A modern **web-based** analyzer for Microsoft Purview audit logs and Entra sign-ins. Upload, filter, and investigate SharePoint, OneDrive, and Exchange activity with an intuitive interface—no CLI required.

> **Note**: purrrr is a detached fork of the original [purviewer](https://github.com/dannystewart/purviewer) project. This version focuses exclusively on the web UI experience with Docker deployment and real-time filtering capabilities.

## Quick Start (Docker)

```bash
# Clone and start the web app
git clone <repo-url>
cd purrrr
docker compose up --build

# Access the interface at http://localhost:5000
```

Upload your CSV audit log, explore data with interactive filters, and export results—all in your browser.

## Web UI Features

### Interactive Filtering & Analysis

- **Real-Time Filtering**: Filter by workload, user, operation, IP address (with wildcard support), and date range
- **Pattern Detection**: Automatically identify repetitive audit patterns across users, IPs, and operations
- **Multiple IP Support**: Filter by single or multiple IPs with wildcard patterns (e.g., `192.168.1.*`)
- **CSV Import**: Upload audit logs and optional user mapping files
- **Session Management**: Analyze multiple logs in separate sessions with persistent state

### Data Insights

- **File Operations**: Track SharePoint/OneDrive file access, downloads, uploads, deletions
- **User Activity**: Map user emails to display names, analyze activity by user
- **Exchange Activity**: Monitor email operations, mailbox access, client applications
- **IP Analysis**: Track source IPs with optional geolocation lookup (manual trigger)
- **User Agent Detection**: Identify suspicious or unusual client applications

### Export & Reporting

- **CSV Export**: Export filtered Exchange activity with all relevant fields
- **JSON API**: Access filtered results programmatically
- **Multi-File Analysis**: Combine results from multiple audit log uploads
- **Batch Operations**: Detect suspicious bulk deletions or downloads

## File Operations Analysis

- **File Activity Tracking**: Analyze downloads, uploads, deletions, and other file operations
- **Path Analysis**: Track access patterns across SharePoint sites and OneDrive folders
- **Bulk Operations Detection**: Identify suspicious mass downloads or deletions
- **File Timeline**: Generate chronological timelines of file access events
- **URL Export**: Export full SharePoint/OneDrive URLs for accessed files

## User Activity Insights

- **User Mapping**: Map user emails to display names via CSV import
- **Activity Filtering**: Filter analysis by specific users or user groups
- **Top Users**: Identify most active users by operation type
- **User Statistics**: Detailed breakdown of user activity patterns

## Security Analysis

- **IP Address Analysis**: Track and analyze source IP addresses with optional geolocation lookup
- **User Agent Detection**: Identify unusual or suspicious client applications
- **Suspicious Pattern Detection**: Flag bulk operations, unusual access patterns, and after-hours activity
- **Network Filtering**: Filter by specific IP addresses or exclude known good IPs with wildcard support

## Exchange Activity

- **Email Operations**: Track email sends, moves, deletions, and rule changes
- **Mailbox Access**: Monitor folder access and email reading patterns
- **Client Application Tracking**: Identify which applications accessed Exchange
- **Detailed Email Analysis**: Extract subjects, senders, recipients, and attachments
- **CSV Export**: Export complete Exchange activity to CSV for further analysis

## Advanced Filtering

- **Date Range**: Filter analysis to specific time periods
- **Action Types**: Focus on specific operations (downloads, uploads, etc.)
- **File Keywords**: Search for files containing specific keywords
- **IP Filtering**: Include or exclude specific IP addresses with wildcard support (e.g., `172.16.*`, `10.0.0.50`)

## Sign-in Analysis (from Entra ID sign-in logs)

- **Authentication Tracking**: Analyze user sign-ins from Microsoft Entra audit logs
- **Failure Detection**: Identify failed sign-ins and authentication errors
- **Device Analysis**: Track device types, operating systems, and client applications
- **Location Monitoring**: Analyze sign-in locations and IP addresses
- **Security Insights**: Detect unusual sign-in patterns and potential security issues

## Installation & Deployment

### Docker (Recommended - Web UI)

#### Prerequisites

- Docker and Docker Compose installed
- Microsoft Purview audit log CSV exports

#### Quick Start

```bash
cd purrrr
docker compose up --build

# Access at http://localhost:5000
```

The Docker setup includes:
- **Flask Web App** (Port 5000): Interactive audit log analysis interface
- **Redis 7** (Alpine, Port 6379): Session and cache management

#### Environment Configuration

Edit `docker-compose.yml` before deployment:

```yaml
environment:
  - FLASK_ENV=production              # Set to 'development' for debug mode
  - REDIS_URL=redis://redis:6379/0   # Redis connection
  - UPLOAD_FOLDER=/tmp/purrrr         # Temporary upload directory
  - MAX_FILE_SIZE=500                 # Max file size in MB
  - SECRET_KEY=your-secure-key        # CHANGE FOR PRODUCTION
```

#### Standalone Web App (Without Docker)

```bash
# Install dependencies
pip install -r requirements.txt

# Run Flask app (requires Redis or uses filesystem fallback)
python run_web.py --host 0.0.0.0 --port 5000 --debug
```

#### Production Deployment

1. **Change SECRET_KEY**: Generate a random, secure key in `docker-compose.yml`
2. **Configure Redis**: Use external Redis for scaling (set `REDIS_URL` env var)
3. **Volume Mounting**: Persist uploads and logs:
   ```bash
   -v /secure/path/uploads:/tmp/purrrr
   -v /secure/path/logs:/app/logs
   ```
4. **Reverse Proxy**: Use Nginx/Traefik in front for SSL/TLS termination
5. **Health Checks**: Endpoints checked every 30s; adjust in `docker-compose.yml` as needed

### CLI Mode (Legacy - Optional)

For command-line usage or automation scripts:

```bash
# Local installation
pip install purrrr

# Analyze from CLI
purrrr audit_log.csv --text
```

**Note**: The web UI is the primary interface. CLI mode is available for backwards compatibility.

## Requirements

- **Python 3.13+**
- **Docker & Docker Compose** (for web UI)
- **Microsoft Purview audit log CSV export** (SharePoint/OneDrive/Exchange analysis)
- **Microsoft Entra sign-in CSV export** (sign-in analysis, optional)

The tool automatically detects SharePoint domains and email domains from your audit data, ensuring seamless integration with any Microsoft 365 tenant.

## Web UI Workflow

1. **Upload**: Select your Purview audit log CSV (and optional user mapping CSV)
2. **Analyze**: System processes and displays all records with pattern detection
3. **Filter**: Use dropdowns and text fields to narrow results:
   - Workload (Exchange, SharePoint, etc.)
   - User (exact or dropdown selection)
   - Operation (SendAs, FileDownloaded, etc.)
   - IP Address (exact, multiple comma-separated, or wildcard patterns)
   - Date/Time range
4. **Explore**: View timeline, export filtered data, analyze patterns
5. **Export**: Download Exchange activity or access results via JSON API

## Architecture

### Web UI Stack

```
┌──────────────────────────────────────────────────────────┐
│                   Docker Environment                      │
├──────────────────────────────────────────────────────────┤
│                                                            │
│  ┌───────────────────┐         ┌────────────────────┐    │
│  │   Flask Web App   │◄───────►│  Redis Session     │    │
│  │   (Port 5000)     │         │  Cache             │    │
│  │   - File Upload   │         │  (Port 6379)       │    │
│  │   - Analysis API  │         │  - Sessions        │    │
│  │   - JSON API      │         │  - File Metadata   │    │
│  │   - HTML UI       │         │  - Filters         │    │
│  └───────────────────┘         └────────────────────┘    │
│           ▲                                                │
│           │ HTTP/WebSocket                               │
└───────────┼────────────────────────────────────────────────┘
            │
      Browser UI
      (localhost:5000)
```

### Data Flow

1. User uploads CSV file → Flask stores in Redis session
2. DataFrame parsed and indexed for filtering
3. Frontend applies filters in real-time (client-side)
4. Pattern detection runs on filtered subset
5. Results cached for multi-session access

## About This Project

**purrrr** is a detached fork of [purviewer](https://github.com/LL7Baucarre/purviewer), refactored to focus exclusively on the web UI experience. Original features (CLI analysis, JSON output) are maintained for backwards compatibility, but all development prioritizes the interactive web interface.

**Key improvements over purviewer**:
- Modern web UI with real-time filtering
- Pattern detection and anomaly highlighting
- Wildcard IP filtering support
- Session-based multi-file analysis
- Docker-ready deployment
- Interactive pattern visualization

## License

purrrr is released under the MIT License. See the LICENSE file for details.
