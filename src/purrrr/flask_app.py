"""Flask web interface for purrrr audit log analyzer."""

from __future__ import annotations

import json
import os
import re
import tempfile
import secrets
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any

import pandas as pd
from flask import Flask, render_template, request, session, Response
from polykit import PolyLog
from werkzeug.utils import secure_filename

try:
    import redis
    from flask_session import Session
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

from purrrr.tools import AuditConfig
from purrrr.geolocation import lookup_ip, get_ip_display, get_geolocation_db, get_asn_db, are_databases_ready

if TYPE_CHECKING:
    from pandas import DataFrame

# Initialize logger
logger = PolyLog.get_logger(simple=True)

# Global progress tracker
progress_tracker = {}

# Global results store (filled by background threads)
analysis_results = {}

# Thread pool for background analysis
executor = ThreadPoolExecutor(max_workers=4)

# Get the directory of this file
current_dir = os.path.dirname(os.path.abspath(__file__))

# Create Flask app with correct paths
app = Flask(
    __name__,
    template_folder=os.path.join(current_dir, "templates"),
    static_folder=os.path.join(current_dir, "static")
)

# Configure Flask app
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024
app.config["UPLOAD_FOLDER"] = tempfile.gettempdir()
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", secrets.token_hex(32))
app.config["SESSION_COOKIE_SECURE"] = False
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=24)
# Disable Jinja2 template caching for development
app.jinja_env.cache = None

# Configure Redis session if available
redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
if REDIS_AVAILABLE:
    try:
        app.config["SESSION_TYPE"] = "redis"
        app.config["SESSION_REDIS"] = redis.from_url(redis_url)
        app.config["SESSION_PERMANENT"] = True
        Session(app)
        logger.info("Redis session management enabled")
    except Exception as e:
        logger.warning(f"Redis connection failed, using default sessions: {e}")
        REDIS_AVAILABLE = False
else:
    app.config["SESSION_TYPE"] = "filesystem"
    logger.warning("Redis not available, using filesystem sessions")

ALLOWED_EXTENSIONS = {"csv"}


def allowed_file(filename: str) -> bool:
    """Check if file extension is allowed."""
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


class AnalysisSession:
    """Manages analysis session data."""

    def __init__(self, df: DataFrame, user_map_df: DataFrame | None = None):
        """Initialize analysis session."""
        self.df = df
        self.user_map_df = user_map_df
        self.config = AuditConfig()

        # Set up user mapping if provided
        if user_map_df is not None:
            self._setup_user_mapping()

    def _setup_user_mapping(self) -> None:
        """Set up user mapping from provided CSV."""
        if self.user_map_df is None:
            return
        try:
            for _, row in self.user_map_df.iterrows():
                if len(row) >= 2:
                    upn = str(row.iloc[0]).strip()
                    name = str(row.iloc[1]).strip()
                    if upn and name:
                        self.config.user_mapping[upn] = name
        except Exception as e:
            logger.error(f"Error setting up user mapping: {e}")


# Global session storage (in production, use proper session management)
sessions: dict[str, AnalysisSession] = {}

# Pre-load databases at startup
logger.info("Pre-loading geolocation and ASN databases...")
get_geolocation_db()
get_asn_db()
logger.info("Databases loaded successfully")


@app.route("/")
def index() -> str:
    """Render home page."""
    import time
    # Force reload test
    return render_template("index.html", cache_bust=int(time.time()))


@app.route("/api/upload", methods=["POST"])
def upload_file() -> tuple[dict[str, Any], int] | dict[str, Any]:
    """Handle file upload and initiate analysis."""
    try:
        if "file" not in request.files:
            return {"error": "No file provided"}, 400

        file = request.files["file"]
        user_map_file = request.files.get("user_map_file")

        if not file.filename:
            return {"error": "No file selected"}, 400

        if not allowed_file(file.filename or ""):
            return {"error": "Only CSV files are allowed"}, 400

        # Save uploaded file
        filename = secure_filename(file.filename or "file.csv")
        filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
        file.save(filepath)

        # Load CSV
        df = pd.read_csv(filepath)

        # Load user mapping if provided
        user_map_df = None
        if user_map_file and user_map_file.filename:
            user_map_filename = secure_filename(user_map_file.filename)
            user_map_filepath = os.path.join(app.config["UPLOAD_FOLDER"], user_map_filename)
            user_map_file.save(user_map_filepath)
            user_map_df = pd.read_csv(user_map_filepath)

        # Create session
        session_id = datetime.now().strftime("%Y%m%d%H%M%S%f")
        session_obj = AnalysisSession(df, user_map_df)
        sessions[session_id] = session_obj

        # Detect log type
        log_type = detect_log_type(df)

        return {
            "session_id": session_id,
            "log_type": log_type,
            "rows": len(df),
            "columns": len(df.columns),
            "filename": filename,
        }

    except Exception as e:
        logger.error(f"Upload error: {e}")
        return {"error": str(e)}, 500


@app.route("/api/upload/<session_id>", methods=["POST"])
def upload_additional_file(session_id: str) -> tuple[dict[str, Any], int] | dict[str, Any]:
    """Handle additional file upload and merge with existing session data."""
    try:
        if session_id not in sessions:
            return {"error": "Session not found"}, 404

        if "file" not in request.files:
            return {"error": "No file provided"}, 400

        file = request.files["file"]

        if not file.filename:
            return {"error": "No file selected"}, 400

        if not allowed_file(file.filename or ""):
            return {"error": "Only CSV files are allowed"}, 400

        # Save uploaded file
        filename = secure_filename(file.filename or "file.csv")
        filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
        file.save(filepath)

        # Load CSV
        new_df = pd.read_csv(filepath)
        rows_added = len(new_df)

        # Get existing session
        session_obj = sessions[session_id]
        
        # Merge dataframes
        session_obj.df = pd.concat([session_obj.df, new_df], ignore_index=True)
        
        # Invalidate cache if Redis is available
        if REDIS_AVAILABLE and app.config.get("SESSION_REDIS"):
            try:
                redis_client = app.config["SESSION_REDIS"]
                redis_key = f"exchange_analysis:{session_id}"
                redis_client.delete(redis_key)
                logger.info(f"Invalidated cache for session: {redis_key}")
            except Exception as e:
                logger.warning(f"Failed to invalidate Redis cache: {e}")

        return {
            "session_id": session_id,
            "rows_added": rows_added,
            "total_rows": len(session_obj.df),
            "filename": filename,
        }

    except Exception as e:
        logger.error(f"Additional upload error: {e}")
        return {"error": str(e)}, 500


@app.route("/api/geoip/download", methods=["POST"])
def download_geoip_database() -> dict[str, Any]:
    """Download or update the GeoIP database."""
    try:
        from purrrr.geolocation import get_geolocation_db
        db = get_geolocation_db()
        db.load_database()  # Force reload/download
        
        return {
            "status": "success",
            "message": "Database downloaded successfully",
            "loaded_ranges": len(db.ip_ranges)
        }
    except Exception as e:
        logger.error(f"GeoIP database download error: {e}")
        return {"status": "error", "message": str(e)}, 500

@app.route("/api/geoip/status", methods=["GET"])
def geoip_status() -> dict[str, Any]:
    """Get GeoIP and ASN database status."""
    try:
        geo_db = get_geolocation_db()
        asn_db = get_asn_db()
        
        return {
            "geoip": {
                "loaded": geo_db.loaded,
                "ranges_count": len(geo_db.ip_ranges),
                "cache_size": len(geo_db.cache)
            },
            "asn": {
                "loaded": asn_db.loaded,
                "ranges_count": len(asn_db.ip_ranges),
                "cache_size": len(asn_db.cache)
            },
            "all_ready": are_databases_ready()
        }
    except Exception as e:
        logger.error(f"Database status error: {e}")
        return {"status": "error", "message": str(e)}, 500

@app.route("/api/analysis/<session_id>/<analysis_type>", methods=["POST"])
def analyze(session_id: str, analysis_type: str) -> tuple[dict[str, Any], int] | dict[str, Any]:
    """Perform analysis on uploaded data."""
    try:
        if session_id not in sessions:
            return {"error": "Session not found"}, 404

        session_obj = sessions[session_id]
        params = request.get_json() or {}

        # Si c'est Exchange, essayer de récupérer depuis Redis d'abord
        if analysis_type == "exchange" and REDIS_AVAILABLE and app.config.get("SESSION_REDIS"):
            try:
                redis_client = app.config["SESSION_REDIS"]
                redis_key = f"exchange_analysis:{session_id}"
                cached_result = redis_client.get(redis_key)
                
                if cached_result:
                    logger.info(f"Retrieved Exchange analysis from Redis cache: {redis_key}")
                    return json.loads(cached_result)
            except Exception as e:
                logger.warning(f"Failed to retrieve from Redis cache: {e}")

        results = {}

        if analysis_type == "file_operations":
            results = analyze_file_operations(session_obj, params)
        elif analysis_type == "user_activity":
            results = analyze_user_activity(session_obj, params)
        elif analysis_type == "exchange":
            # Pour Exchange, l'analyse se fait de manière synchrone mais avec progress tracking
            logger.info(f"🚀 Starting Exchange analysis for session: {session_id}")
            results = analyze_exchange(session_obj, params, session_id)
        elif analysis_type == "summary":
            results = analyze_summary(session_obj)
        else:
            return {"error": f"Unknown analysis type: {analysis_type}"}, 400

        # Ensure we always return a dict
        if not isinstance(results, dict):
            results = {"error": "Invalid analysis result"}
        
        return results

    except Exception as e:
        logger.error(f"Analysis error: {e}")
        return {"error": str(e)}, 500

@app.route("/api/analysis/start/<session_id>", methods=["POST"])
def start_analysis(session_id: str) -> tuple[dict[str, Any], int] | dict[str, Any]:
    """Start analysis in a background thread. Returns immediately."""
    try:
        if session_id not in sessions:
            return {"error": "Session not found"}, 404

        session_obj = sessions[session_id]
        params = request.get_json() or {}
        analysis_type = params.get("analysis_type", "exchange")

        # Check if already running
        if session_id in progress_tracker and not progress_tracker[session_id].get("complete", True):
            return {"status": "already_running", "session_id": session_id}

        # Check Redis cache first
        if analysis_type == "exchange" and REDIS_AVAILABLE and app.config.get("SESSION_REDIS"):
            try:
                redis_client = app.config["SESSION_REDIS"]
                redis_key = f"exchange_analysis:{session_id}"
                cached_result = redis_client.get(redis_key)
                if cached_result:
                    logger.info(f"Cache hit for {redis_key}")
                    analysis_results[session_id] = json.loads(cached_result)
                    progress_tracker[session_id] = {
                        "current": 1, "total": 1, "percent": 100,
                        "message": "Chargé depuis le cache", "complete": True
                    }
                    return {"status": "started", "session_id": session_id, "cached": True}
            except Exception as e:
                logger.warning(f"Redis cache error: {e}")

        # Initialize progress
        progress_tracker[session_id] = {
            "current": 0, "total": 0, "percent": 0,
            "message": "Démarrage de l'analyse...", "complete": False
        }

        # Launch in background thread
        def run_analysis():
            try:
                logger.info(f"🚀 Background analysis started for {session_id}")
                if analysis_type == "exchange":
                    result = analyze_exchange(session_obj, params, session_id)
                elif analysis_type == "file_operations":
                    result = analyze_file_operations(session_obj, params)
                elif analysis_type == "user_activity":
                    result = analyze_user_activity(session_obj, params)
                elif analysis_type == "summary":
                    result = analyze_summary(session_obj)
                else:
                    result = {"error": f"Unknown type: {analysis_type}"}

                analysis_results[session_id] = result
                logger.info(f"✅ Background analysis completed for {session_id}")

                # Cache in Redis
                if analysis_type == "exchange" and REDIS_AVAILABLE and app.config.get("SESSION_REDIS"):
                    try:
                        redis_client = app.config["SESSION_REDIS"]
                        redis_key = f"exchange_analysis:{session_id}"
                        redis_client.setex(redis_key, timedelta(hours=24), json.dumps(result, default=str))
                    except Exception as e:
                        logger.warning(f"Redis cache store error: {e}")

            except Exception as e:
                logger.error(f"Background analysis error: {e}", exc_info=True)
                analysis_results[session_id] = {"error": str(e)}
                progress_tracker[session_id] = {
                    "current": 0, "total": 0, "percent": 0,
                    "message": f"Erreur: {e}", "complete": True, "error": True
                }

        executor.submit(run_analysis)
        logger.info(f"📨 Analysis submitted to thread pool for {session_id}")

        return {"status": "started", "session_id": session_id}

    except Exception as e:
        logger.error(f"Start analysis error: {e}")
        return {"error": str(e)}, 500


@app.route("/api/analysis/progress/<session_id>", methods=["GET"])
def get_analysis_progress(session_id: str) -> dict[str, Any]:
    """Get current analysis progress. Called by frontend polling."""
    if session_id in progress_tracker:
        return progress_tracker[session_id]
    return {
        "current": 0, "total": 0, "percent": 0,
        "message": "En attente...", "complete": False
    }


@app.route("/api/analysis/result/<session_id>", methods=["GET"])
def get_analysis_result(session_id: str) -> tuple[dict[str, Any], int] | dict[str, Any]:
    """Get the result of a completed analysis."""
    if session_id in analysis_results:
        result = analysis_results.pop(session_id)  # Get and remove
        # Clean up progress tracker
        progress_tracker.pop(session_id, None)
        return result
    return {"error": "No result available yet"}, 202


def detect_log_type(df: DataFrame) -> str:
    """Detect the type of log file based on columns."""
    columns = set(df.columns)

    # Check for Entra sign-in logs
    if "User" in columns or "Username" in columns:
        if "Status" in columns and "Application" in columns:
            return "entra"

    # Check for Exchange logs
    if "MailboxOwnerUPN" in columns or "ClientInfoString" in columns:
        return "exchange"

    # Check for Purview file operations
    if "SourceFileName" in columns or "Operation" in columns:
        return "purview"

    return "unknown"

def apply_filters(df: DataFrame, params: dict[str, Any]) -> DataFrame:
    """Apply user-defined filters to the DataFrame."""
    # User filter
    if params.get("user"):
        user_filter = params["user"].lower()
        df = df[df["UserId"].str.contains(user_filter, case=False, na=False)]
    
    # Actions filter
    if params.get("actions"):
        actions_list = [a.strip() for a in params["actions"].split(",")]
        if "Operation" in df.columns:
            df = df[df["Operation"].isin(actions_list)]
    
    # File search
    if params.get("files"):
        keyword = params["files"].lower()
        if "SourceFileName" in df.columns:
            df = df[df["SourceFileName"].str.contains(keyword, case=False, na=False)]
    
    # IP filter
    if params.get("ips"):
        ip_filter = params["ips"]
        if "ClientIPAddress" in df.columns:
            # Simple wildcard support: replace * with regex pattern
            ip_pattern = ip_filter.replace("*", ".*").replace(".", r"\.")
            df = df[df["ClientIPAddress"].str.contains(ip_pattern, regex=True, case=False, na=False)]
    
    # Exclude IPs
    if params.get("exclude_ips"):
        exclude_filter = params["exclude_ips"]
        if "ClientIPAddress" in df.columns:
            exclude_pattern = exclude_filter.replace("*", ".*").replace(".", r"\.")
            df = df[~df["ClientIPAddress"].str.contains(exclude_pattern, regex=True, case=False, na=False)]
    
    # Date range filter
    if params.get("start_date") and params.get("end_date"):
        df = filter_by_date(df, params["start_date"], params["end_date"])
    
    return df

def filter_detailed_operations(detailed_ops: list[dict[str, Any]], params: dict[str, Any]) -> list[dict[str, Any]]:
    """Filter detailed operations based on user parameters."""
    filtered_ops = detailed_ops
    
    # User filter
    if params.get("user"):
        user_filter = params["user"].lower()
        filtered_ops = [op for op in filtered_ops 
                       if user_filter in (op.get("user", "").lower())]
    
    # Actions filter
    if params.get("actions"):
        actions_list = [a.strip() for a in params["actions"].split(",")]
        filtered_ops = [op for op in filtered_ops 
                       if op.get("operation") in actions_list]
    
    # IP filter - requires checking full_data
    if params.get("ips"):
        ip_filter = params["ips"]
        ip_pattern = ip_filter.replace("*", ".*").replace(".", r"\.")
        pattern = re.compile(ip_pattern, re.IGNORECASE)
        filtered_ops = [op for op in filtered_ops 
                       if op.get("full_data") and 
                           pattern.search(op["full_data"].get("ClientIPAddress", ""))]
    
    # Exclude IPs
    if params.get("exclude_ips"):
        exclude_filter = params["exclude_ips"]
        exclude_pattern = exclude_filter.replace("*", ".*").replace(".", r"\.")
        pattern = re.compile(exclude_pattern, re.IGNORECASE)
        filtered_ops = [op for op in filtered_ops 
                       if not (op.get("full_data") and 
                              pattern.search(op["full_data"].get("ClientIPAddress", "")))]
    
    # Country filter
    if params.get("country"):
        country_filter = params["country"]
        # Can be a list or single value
        if isinstance(country_filter, str):
            country_filter = [country_filter]
        filtered_ops = [op for op in filtered_ops 
                       if op.get("geo_country") in country_filter or op.get("geo_country_code") in country_filter]
    
    # ASN filter
    if params.get("asn"):
        asn_filter = params["asn"]
        # Can be a list or single value
        if isinstance(asn_filter, str):
            asn_filter = [asn_filter]
        filtered_ops = [op for op in filtered_ops 
                       if op.get("asn") in asn_filter]
    
    # Date range filter
    if params.get("start_date") and params.get("end_date"):
        try:
            start_date = datetime.strptime(params["start_date"], "%Y-%m-%d").date()
            end_date = datetime.strptime(params["end_date"], "%Y-%m-%d").date()
            filtered_ops = [op for op in filtered_ops
                           if start_date <= datetime.fromisoformat(op.get("timestamp", "")).date() <= end_date]
        except (ValueError, AttributeError):
            pass
    
    return filtered_ops

def analyze_file_operations(session: AnalysisSession, params: dict[str, Any]) -> dict[str, Any]:
    """Analyze file operations with detailed breakdown."""
    df = session.df
    
    # Apply filters
    df = apply_filters(df, params)

    # Get summary statistics
    total_operations = len(df)
    unique_files = df["SourceFileName"].nunique() if "SourceFileName" in df.columns else 0
    unique_users = df["UserId"].nunique() if "UserId" in df.columns else 0

    # Get top files with details
    top_files = {}
    files_by_user = {}
    if "SourceFileName" in df.columns and "UserId" in df.columns:
        top_files = df["SourceFileName"].value_counts().head(15).to_dict()
        
        # Get files and users accessing them
        for file in df["SourceFileName"].unique()[:10]:
            file_df = df[df["SourceFileName"] == file]
            files_by_user[file] = {
                "count": len(file_df),
                "users": file_df["UserId"].unique().tolist()[:5],
                "operations": file_df["Operation"].value_counts().to_dict()
            }

    # Get operation breakdown
    operations_breakdown = {}
    operations_by_user = {}
    if "Operation" in df.columns:
        operations_breakdown = df["Operation"].value_counts().to_dict()
        
        # Get operations by user
        if "UserId" in df.columns:
            for user in df["UserId"].unique()[:10]:
                user_df = df[df["UserId"] == user]
                operations_by_user[user] = user_df["Operation"].value_counts().to_dict()

    # Get users with most operations
    top_users_detail = {}
    if "UserId" in df.columns:
        for user in df["UserId"].value_counts().head(10).index:
            user_df = df[df["UserId"] == user]
            display_name = session.config.user_mapping.get(user, user)
            top_users_detail[display_name] = {
                "count": len(user_df),
                "operations": user_df["Operation"].value_counts().to_dict(),
                "files": user_df["SourceFileName"].nunique() if "SourceFileName" in user_df.columns else 0
            }

    return {
        "summary": {
            "total_operations": int(total_operations),
            "unique_files": int(unique_files),
            "unique_users": int(unique_users),
        },
        "top_files": top_files,
        "operations": operations_breakdown,
        "operations_by_user": operations_by_user,
        "files_by_user": files_by_user,
        "top_users_detail": top_users_detail,
    }

def analyze_user_activity(session: AnalysisSession, params: dict[str, Any]) -> dict[str, Any]:
    """Analyze user activity with detailed statistics."""
    df = session.df
    
    # Apply filters
    df = apply_filters(df, params)

    # Get top users
    top_users = {}
    user_detailed_stats = {}
    user_activity_timeline = {}

    if "UserId" in df.columns:
        user_activity = df["UserId"].value_counts().head(15).to_dict()
        for user, count in user_activity.items():
            display_name = session.config.user_mapping.get(user, user)
            top_users[display_name] = int(count)

    # Get detailed user statistics
    if "UserId" in df.columns:
        for user in df["UserId"].unique()[:20]:
            user_df = df[df["UserId"] == user]
            display_name = session.config.user_mapping.get(user, user)
            
            stats = {
                "operations": len(user_df),
                "unique_files": user_df["SourceFileName"].nunique()
                if "SourceFileName" in user_df.columns
                else 0,
                "first_action": str(user_df["CreationDate"].min())
                if "CreationDate" in user_df.columns
                else "",
                "last_action": str(user_df["CreationDate"].max())
                if "CreationDate" in user_df.columns
                else "",
            }
            
            # Add operation breakdown per user
            if "Operation" in user_df.columns:
                stats["operations_breakdown"] = user_df["Operation"].value_counts().to_dict()
            
            user_detailed_stats[display_name] = stats

    return {
        "top_users": top_users,
        "user_stats": user_detailed_stats,
        "user_activity_timeline": user_activity_timeline,
    }


def _add_geolocation_to_operation(op_dict: dict[str, Any]) -> dict[str, Any]:
    """Add geolocation and ASN information to an operation dict."""
    # Initialize with empty values
    op_dict.setdefault("geo_country", "")
    op_dict.setdefault("geo_country_code", "")
    op_dict.setdefault("geo_continent", "")
    op_dict.setdefault("asn", "")
    op_dict.setdefault("as_name", "")
    op_dict.setdefault("as_domain", "")
    
    if op_dict.get("ClientIP"):
        # Get GeoIP data
        geo_data = lookup_ip(op_dict["ClientIP"])
        if geo_data:
            op_dict["geo_country"] = geo_data.get("country_name", "")
            op_dict["geo_country_code"] = geo_data.get("country_code", "")
            op_dict["geo_continent"] = geo_data.get("continent_code", "")
            # Also add to full_data if it exists
            if op_dict.get("full_data"):
                op_dict["full_data"]["_geo_country"] = geo_data.get("country_name", "")
                op_dict["full_data"]["_geo_country_code"] = geo_data.get("country_code", "")
                op_dict["full_data"]["_geo_continent"] = geo_data.get("continent_code", "")
        
        # Get ASN data
        from purrrr.geolocation import lookup_asn
        asn_data = lookup_asn(op_dict["ClientIP"])
        if asn_data:
            op_dict["asn"] = asn_data.get("asn", "")
            op_dict["as_name"] = asn_data.get("as_name", "")
            op_dict["as_domain"] = asn_data.get("as_domain", "")
            # Also add to full_data if it exists
            if op_dict.get("full_data"):
                op_dict["full_data"]["_asn"] = asn_data.get("asn", "")
                op_dict["full_data"]["_as_name"] = asn_data.get("as_name", "")
                op_dict["full_data"]["_as_domain"] = asn_data.get("as_domain", "")
    
    return op_dict


def analyze_exchange(session: AnalysisSession, params: dict[str, Any], session_id: str | None = None) -> dict[str, Any]:
    """Analyze exchange activity with detailed breakdown.
    
    Optimizations:
    - Pre-caches all unique IPs before processing (avoids redundant lookups)
    - Uses bisect-indexed geo/ASN databases (O(log n) instead of O(n))
    - Processes rows via DataFrame column access (faster than iterrows)
    - Parallel chunk processing via ThreadPoolExecutor
    """
    import time as _time
    from concurrent.futures import ThreadPoolExecutor as _TPE, as_completed
    
    try:
        df = session.df.copy()
        
        # Apply filters
        df = apply_filters(df, params)
        
        total_rows = len(df)
        t0 = _time.perf_counter()
        print(f"\n📊 [ANALYSE EXCHANGE] Début du traitement: {total_rows} opérations à traiter")
        
        # Initialize progress tracker
        if session_id:
            progress_tracker[session_id] = {
                "current": 0,
                "total": total_rows,
                "percent": 0,
                "message": "Pré-chargement des adresses IP...",
                "complete": False
            }

        # ── Phase 1: Pre-cache all unique IPs ──────────────────────────────
        unique_ips: set[str] = set()
        has_audit_data = "AuditData" in df.columns
        
        # Fast IP extraction: gather all unique IPs from columns first
        for col in ["ClientIP", "ClientIPAddress", "client_ip", "SenderIp"]:
            if col in df.columns:
                unique_ips.update(df[col].dropna().unique())
        
        # Extract IPs from AuditData JSON (fast scan)
        if has_audit_data:
            for raw in df["AuditData"].dropna():
                try:
                    ad = json.loads(raw)
                    for k in ("ClientIP", "ClientIPAddress", "client_ip", "SenderIp"):
                        v = ad.get(k)
                        if v:
                            unique_ips.add(str(v))
                except (json.JSONDecodeError, TypeError):
                    pass
        
        # Discard empty strings
        unique_ips.discard("")
        
        from purrrr.geolocation import precache_ips
        precache_ips(unique_ips)
        
        if session_id:
            progress_tracker[session_id]["message"] = "Traitement des opérations..."
        
        # ── Phase 2: Split into chunks and process in parallel ─────────────
        NUM_WORKERS = 4
        chunk_size = max(500, total_rows // NUM_WORKERS)
        df_reset = df.reset_index(drop=True)
        columns_set = set(df.columns)
        
        chunks = []
        for i in range(0, total_rows, chunk_size):
            chunk_df = df_reset.iloc[i:i + chunk_size]
            chunks.append((i, i, chunk_df, columns_set))
        
        print(f"  🔀 Traitement parallèle: {len(chunks)} chunks de ~{chunk_size} lignes avec {NUM_WORKERS} workers")
        
        # Shared progress counter updated by workers every N rows
        import threading
        _progress_lock = threading.Lock()
        _progress_count = [0]
        
        def _update_progress(rows_done: int):
            """Thread-safe progress update called from within chunk processing."""
            with _progress_lock:
                _progress_count[0] += rows_done
                if session_id:
                    done = min(_progress_count[0], total_rows)
                    pct = done / total_rows * 100
                    progress_tracker[session_id] = {
                        "current": done,
                        "total": total_rows,
                        "percent": round(pct, 1),
                        "message": f"Traitement: {done}/{total_rows} opérations",
                        "complete": False
                    }
        
        # Process chunks in parallel
        all_chunk_results = []
        with _TPE(max_workers=NUM_WORKERS) as pool:
            futures = {
                pool.submit(_process_exchange_chunk_fast, i, s, c, cols, _update_progress): (i, s)
                for i, s, c, cols in chunks
            }
            for future in as_completed(futures):
                all_chunk_results.extend(future.result())
        
        t_process = _time.perf_counter()
        print(f"  ⚡ Traitement parallèle terminé en {t_process - t0:.2f}s")
        
        # ── Phase 3: Aggregate results ─────────────────────────────────────
        if session_id:
            progress_tracker[session_id]["message"] = "Agrégation des résultats..."

        exchange_stats = {
            "total_operations": total_rows,
            "unique_mailboxes": 0,
            "operations_by_type": {},
            "operations_by_user": {},
            "detailed_operations": [],
            "operation_details": {},
            "countries": [],
            "unique_countries": 0,
        }

        users_by_operation: dict[str, dict[str, int]] = {}
        unique_mailboxes: set[str] = set()
        operation_details_by_type: dict[str, list[dict[str, Any]]] = {}
        detailed_ops: list[dict[str, Any]] = []
        
        for item in all_chunk_results:
            user = item.get("user")
            operation = item.get("operation", "Unknown")
            
            if item.get("_is_timeline"):
                detailed_ops.append(item)
            
            if user:
                unique_mailboxes.add(user)
                if operation not in users_by_operation:
                    users_by_operation[operation] = {}
                if user not in users_by_operation[operation]:
                    users_by_operation[operation][user] = 0
                users_by_operation[operation][user] += 1
            
            # Collect email details for accordion
            email_details = item.get("_email_details")
            if email_details:
                if operation not in operation_details_by_type:
                    operation_details_by_type[operation] = []
                operation_details_by_type[operation].extend(email_details)

        exchange_stats["unique_mailboxes"] = len(unique_mailboxes)

        # Get operations by type (fast pandas value_counts)
        if "Operation" in df.columns:
            exchange_stats["operations_by_type"] = df["Operation"].value_counts().to_dict()

        # Get operations by user with details
        user_operations: dict[str, dict[str, int]] = {}
        for operation, users_dict in users_by_operation.items():
            for user, count in users_dict.items():
                if user not in user_operations:
                    user_operations[user] = {}
                user_operations[user][operation] = count
        
        # Populate operations_by_user
        for user, operations_dict in user_operations.items():
            display_name = session.config.user_mapping.get(user, user)
            exchange_stats["operations_by_user"][display_name] = {
                "total": sum(operations_dict.values()),
                "operations": operations_dict
            }
        
        # Store operation details (max 100 per operation for performance)
        for op_type, details_list in operation_details_by_type.items():
            exchange_stats["operation_details"][op_type] = details_list[:100]

        # Sort by timestamp (descending - most recent first)
        detailed_ops.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
        
        # Apply detailed filters to operations timeline
        detailed_ops = filter_detailed_operations(detailed_ops, params)
        
        # Clean internal keys from timeline ops before sending to frontend
        for op in detailed_ops:
            op.pop("_is_timeline", None)
            op.pop("_email_details", None)
        
        exchange_stats["detailed_operations"] = detailed_ops
        
        # Analyze countries from geolocation data
        countries_analysis = analyze_countries(detailed_ops)
        exchange_stats["countries"] = countries_analysis.get("countries", [])
        exchange_stats["unique_countries"] = countries_analysis.get("total_unique", 0)

        t_total = _time.perf_counter()
        print(f"✅ [ANALYSE EXCHANGE] Traitement terminé en {t_total - t0:.2f}s!")
        print(f"   - {exchange_stats['total_operations']} opérations filtrées")
        print(f"   - {exchange_stats['unique_countries']} pays uniques")
        print(f"   - {len(exchange_stats['operations_by_type'])} types d'opérations")
        
        # Mark progress as complete
        if session_id:
            progress_tracker[session_id] = {
                "current": total_rows,
                "total": total_rows,
                "percent": 100,
                "message": f"Analyse terminée en {t_total - t0:.1f}s!",
                "complete": True
            }
        
        return exchange_stats
    
    except Exception as e:
        logger.error(f"Error in analyze_exchange: {e}", exc_info=True)
        if session_id:
            progress_tracker[session_id] = {
                "current": 0,
                "total": 0,
                "percent": 100,
                "message": f"Erreur: {str(e)}",
                "complete": True
            }
        return {
            "total_operations": 0,
            "unique_mailboxes": 0,
            "operations_by_type": {},
            "operations_by_user": {},
            "detailed_operations": [],
            "operation_details": {},
            "countries": [],
            "unique_countries": 0,
            "error": str(e)
        }


def _process_exchange_chunk_fast(chunk_idx: int, start_idx: int, df_chunk, columns_set: set, progress_callback=None) -> list[dict[str, Any]]:
    """Process a chunk of DataFrame rows for exchange analysis.
    
    Returns a list of dicts, each with:
    - user, operation, _is_timeline (bool), _email_details (list or None)
    - plus all timeline fields (timestamp, subject, folder, geo_*, asn, etc.)
    """
    results = []
    has_audit_data = "AuditData" in columns_set
    PROGRESS_INTERVAL = 200  # Report progress every N rows
    rows_since_report = 0
    
    for _, row in df_chunk.iterrows():
        rows_since_report += 1
        if progress_callback and rows_since_report >= PROGRESS_INTERVAL:
            progress_callback(rows_since_report)
            rows_since_report = 0
        operation = row.get("Operation", "Unknown")
        
        # Try to get user info from different column sources
        user = None
        if "MailboxOwnerUPN" in columns_set and pd.notna(row.get("MailboxOwnerUPN")):
            user = row.get("MailboxOwnerUPN")
        elif "UserId" in columns_set and pd.notna(row.get("UserId")):
            user = row.get("UserId")
        
        # Extract detailed info from AuditData JSON
        email_details_list: list[dict[str, Any]] = []
        timestamp = None
        client_ip = ""
        
        if has_audit_data and pd.notna(row.get("AuditData")):
            try:
                audit_data = json.loads(row.get("AuditData", "{}"))
                timestamp = audit_data.get("CreationTime", "")
                
                # Extract user from AuditData if not found in columns
                if not user:
                    if "MailboxOwnerUPN" in audit_data:
                        user = audit_data["MailboxOwnerUPN"]
                    elif "UserId" in audit_data:
                        user = audit_data["UserId"]
                
                # Extract IP from various locations
                client_ip = (row.get("ClientIP") or row.get("ClientIPAddress") or 
                            row.get("client_ip") or row.get("SenderIp") or
                            audit_data.get("ClientIP") or audit_data.get("ClientIPAddress") or 
                            audit_data.get("client_ip") or audit_data.get("SenderIp") or "")
                
                # Special handling for MailItemsAccessed with Folders structure
                if operation == "MailItemsAccessed" and "Folders" in audit_data and audit_data["Folders"]:
                    item_count = 0
                    for folder_item in audit_data["Folders"]:
                        folder_path = folder_item.get("Path", "")
                        folder_items = folder_item.get("FolderItems", [])
                        for item in folder_items:
                            if item_count >= 3:
                                break
                            email_details_list.append({
                                "timestamp": timestamp,
                                "subject": item.get("Subject", ""),
                                "folder": folder_path,
                                "size": item.get("SizeInBytes", 0),
                            })
                            item_count += 1
                        if item_count >= 3:
                            break
                    
                    if user and audit_data["Folders"]:
                        folder = audit_data["Folders"][0]
                        fi = folder.get("FolderItems", [])
                        if fi:
                            op_dict = {
                                "timestamp": timestamp,
                                "operation": operation,
                                "subject": fi[0].get("Subject", ""),
                                "folder": folder.get("Path", ""),
                                "user": user,
                                "Workload": audit_data.get("Workload", ""),
                                "ClientIP": client_ip,
                                "full_data": audit_data,
                                "_is_timeline": True,
                                "_email_details": email_details_list or None,
                            }
                            op_dict = _add_geolocation_to_operation(op_dict)
                            results.append(op_dict)
                            continue  # Already added user + email_details
                
                # Special handling for New-InboxRule and Set-InboxRule
                elif operation in ("New-InboxRule", "Set-InboxRule") and "Parameters" in audit_data:
                    parameters = audit_data.get("Parameters", [])
                    param_dict = {}
                    if isinstance(parameters, list):
                        for param in parameters:
                            if isinstance(param, dict):
                                param_dict[param.get("Name", "")] = param.get("Value", "")
                    
                    rule_name = param_dict.get("Name", "")
                    rule_from = param_dict.get("From", "")
                    rule_id = param_dict.get("Identity", "")
                    
                    if rule_name or rule_from:
                        email_details_list.append({
                            "timestamp": timestamp,
                            "subject": f"Rule: {rule_name}" if rule_name else "Inbox Rule Change",
                            "folder": f"From: {rule_from}" if rule_from else rule_id or "N/A",
                            "size": 0,
                        })
                    
                    if user:
                        op_dict = {
                            "timestamp": timestamp,
                            "operation": operation,
                            "subject": f"Rule: {rule_name}" if rule_name else "Inbox Rule",
                            "folder": f"From: {rule_from}" if rule_from else "",
                            "user": user,
                            "Workload": audit_data.get("Workload", ""),
                            "ClientIP": client_ip,
                            "full_data": audit_data,
                            "_is_timeline": True,
                            "_email_details": email_details_list or None,
                        }
                        op_dict = _add_geolocation_to_operation(op_dict)
                        results.append(op_dict)
                        continue
                
                # Generic operation handling
                else:
                    subject = audit_data.get("Subject")
                    folder = ""
                    size = 0
                    
                    if "Item" in audit_data:
                        item = audit_data["Item"]
                        subject = subject or item.get("Subject", "")
                        folder = item.get("ParentFolder", {}).get("Path", "")
                        size = item.get("SizeInBytes", 0)
                    elif "AffectedItems" in audit_data and audit_data["AffectedItems"]:
                        affected_item = audit_data["AffectedItems"][0]
                        subject = subject or affected_item.get("Subject", "")
                        folder = affected_item.get("ParentFolder", {}).get("Path", "")
                        size = affected_item.get("SizeInBytes", 0)
                    
                    if subject or folder or size:
                        email_details_list.append({
                            "timestamp": timestamp,
                            "subject": subject or "",
                            "folder": folder,
                            "size": size,
                        })
                    
                    if user:
                        op_dict = {
                            "timestamp": timestamp,
                            "operation": operation,
                            "subject": subject or "",
                            "folder": folder,
                            "user": user,
                            "Workload": audit_data.get("Workload", ""),
                            "ClientIP": client_ip,
                            "full_data": audit_data,
                            "_is_timeline": True,
                            "_email_details": email_details_list or None,
                        }
                        op_dict = _add_geolocation_to_operation(op_dict)
                        results.append(op_dict)
                        continue
                    
            except (json.JSONDecodeError, TypeError):
                pass
        
        # If we haven't added via continue, still track user + operation
        if user:
            results.append({
                "user": user,
                "operation": operation,
                "_is_timeline": False,
                "_email_details": email_details_list or None,
            })
    
    # Report remaining rows
    if progress_callback and rows_since_report > 0:
        progress_callback(rows_since_report)
    
    return results


def analyze_summary(session: AnalysisSession) -> dict[str, Any]:
    """Get overall summary."""
    df = session.df
    log_type = detect_log_type(df)

    summary = {
        "log_type": log_type,
        "total_records": len(df),
        "columns": list(df.columns),
        "date_range": {
            "start": str(df.iloc[0].get("CreationDate", "")) if len(df) > 0 else "",
            "end": str(df.iloc[-1].get("CreationDate", "")) if len(df) > 0 else "",
        },
        "file_info": {
            "memory_usage": str(df.memory_usage(deep=True).sum() / 1024 / 1024) + " MB",
        },
    }

    return summary


def analyze_countries(detailed_ops: list[dict[str, Any]]) -> dict[str, Any]:
    """Analyze geolocation data from operations."""
    countries_data = {}
    
    for op in detailed_ops:
        country_code = op.get("geo_country_code", "")
        country_name = op.get("geo_country", "Unknown")
        continent = op.get("geo_continent", "")
        
        if country_code or country_name != "Unknown":
            key = f"{country_code}|{country_name}|{continent}"
            if key not in countries_data:
                countries_data[key] = 0
            countries_data[key] += 1
    
    # Convert to list and sort by count
    countries_list = [
        {
            "country_code": k.split("|")[0] or "-",
            "country_name": k.split("|")[1],
            "continent": k.split("|")[2] or "-",
            "count": v
        }
        for k, v in countries_data.items()
    ]
    countries_list.sort(key=lambda x: x["count"], reverse=True)
    
    return {
        "countries": countries_list[:50],  # Top 50 countries
        "total_unique": len(countries_list)
    }


def filter_by_date(df: DataFrame, start_date: str, end_date: str) -> DataFrame:
    """Filter dataframe by date range."""
    try:
        if "CreationDate" in df.columns:
            df["CreationDate"] = pd.to_datetime(df["CreationDate"])
            df = df[
                (df["CreationDate"] >= start_date) & (df["CreationDate"] <= end_date)
            ]
    except Exception as e:
        logger.error(f"Date filtering error: {e}")
    return df


@app.errorhandler(413)
def request_entity_too_large(error: Any) -> tuple[dict[str, str], int]:
    """Handle file too large error."""
    return {"error": "File is too large (max 500MB)"}, 413


@app.errorhandler(404)
def not_found(error: Any) -> tuple[dict[str, str], int]:
    """Handle 404 errors."""
    return {"error": "Page not found"}, 404


@app.errorhandler(500)
def internal_error(error: Any) -> tuple[dict[str, str], int]:
    """Handle 500 errors."""
    return {"error": "Internal server error"}, 500


def run_flask_app(host: str = "0.0.0.0", port: int = 5000, debug: bool = False) -> None:
    """Run the Flask application."""
    app.run(host=host, port=port, debug=debug, threaded=True)


if __name__ == "__main__":
    run_flask_app(debug=True)
