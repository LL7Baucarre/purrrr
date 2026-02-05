"""Flask web interface for Purviewer audit log analyzer."""

from __future__ import annotations

import json
import os
import tempfile
import secrets
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

import pandas as pd
from flask import Flask, render_template, request, session
from polykit import PolyLog
from werkzeug.utils import secure_filename

try:
    import redis
    from flask_session import Session
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

from purviewer.tools import AuditConfig

if TYPE_CHECKING:
    from pandas import DataFrame

# Initialize logger
logger = PolyLog.get_logger(simple=True)

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


@app.route("/")
def index() -> str:
    """Render home page."""
    return render_template("index.html")


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

        # Pré-calculer l'analyse Exchange et la stocker dans Redis
        try:
            exchange_results = analyze_exchange(session_obj, {})
            
            # Stocker dans Redis si disponible
            if REDIS_AVAILABLE and app.config.get("SESSION_REDIS"):
                redis_client = app.config["SESSION_REDIS"]
                redis_key = f"exchange_analysis:{session_id}"
                redis_client.setex(
                    redis_key,
                    timedelta(hours=24),
                    json.dumps(exchange_results, default=str)
                )
                logger.info(f"Exchange analysis cached in Redis: {redis_key}")
        except Exception as e:
            logger.warning(f"Failed to pre-compute Exchange analysis: {e}")

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
            results = analyze_exchange(session_obj, params)
        elif analysis_type == "summary":
            results = analyze_summary(session_obj)
        else:
            return {"error": f"Unknown analysis type: {analysis_type}"}, 400

        return results

    except Exception as e:
        logger.error(f"Analysis error: {e}")
        return {"error": str(e)}, 500

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

def analyze_exchange(session: AnalysisSession, params: dict[str, Any]) -> dict[str, Any]:
    """Analyze exchange activity with detailed breakdown."""
    df = session.df.copy()
    
    # Apply filters
    df = apply_filters(df, params)

    exchange_stats = {
        "total_operations": len(df),
        "unique_mailboxes": 0,
        "operations_by_type": {},
        "operations_by_user": {},
        "detailed_operations": [],
        "operation_details": {},
    }

    # Extract user info from AuditData JSON if needed
    users_by_operation = {}
    unique_mailboxes = set()
    operation_details_by_type: dict[str, list[dict[str, Any]]] = {}

    for _, row in df.iterrows():
        operation = row.get("Operation", "Unknown")
        
        # Try to get user info from different column sources
        user = None
        if "MailboxOwnerUPN" in df.columns and pd.notna(row.get("MailboxOwnerUPN")):
            user = row.get("MailboxOwnerUPN")
        elif "UserId" in df.columns and pd.notna(row.get("UserId")):
            user = row.get("UserId")
        
        # Extract detailed info from AuditData JSON
        email_details_list: list[dict[str, Any]] = []
        timestamp = None
        
        if "AuditData" in df.columns and pd.notna(row.get("AuditData")):
            try:
                audit_data = json.loads(row.get("AuditData", "{}"))
                timestamp = audit_data.get("CreationTime", "")
                
                # Extract user from AuditData if not found in columns
                if not user:
                    if "MailboxOwnerUPN" in audit_data:
                        user = audit_data["MailboxOwnerUPN"]
                    elif "UserId" in audit_data:
                        user = audit_data["UserId"]
                
                # Special handling for MailItemsAccessed with Folders structure
                if operation == "MailItemsAccessed" and "Folders" in audit_data and audit_data["Folders"]:
                    # Extract items from Folders array - limit to max 3 items per operation for performance
                    item_count = 0
                    for folder_item in audit_data["Folders"]:
                        folder_path = folder_item.get("Path", "")
                        folder_items = folder_item.get("FolderItems", [])
                        
                        for item in folder_items:
                            if item_count >= 3:
                                break
                            email_details = {
                                "timestamp": timestamp,
                                "subject": item.get("Subject", ""),
                                "folder": folder_path,
                                "size": item.get("SizeInBytes", 0),
                            }
                            email_details_list.append(email_details)
                            item_count += 1
                        if item_count >= 3:
                            break
                # Special handling for New-InboxRule and Set-InboxRule - extract from Parameters
                elif operation in ["New-InboxRule", "Set-InboxRule"] and "Parameters" in audit_data:
                    parameters = audit_data.get("Parameters", [])
                    param_dict = {}
                    if isinstance(parameters, list):
                        for param in parameters:
                            if isinstance(param, dict):
                                param_dict[param.get("Name", "")] = param.get("Value", "")
                    
                    # Extract relevant parameters
                    rule_name = param_dict.get("Name", "")
                    rule_from = param_dict.get("From", "")
                    rule_id = param_dict.get("Identity", "")
                    
                    if rule_name or rule_from:
                        email_details = {
                            "timestamp": timestamp,
                            "subject": f"Rule: {rule_name}" if rule_name else "Inbox Rule Change",
                            "folder": f"From: {rule_from}" if rule_from else rule_id or "N/A",
                            "size": 0,
                        }
                        email_details_list.append(email_details)
                else:
                    # Original logic for other operations
                    subject = audit_data.get("Subject")
                    folder = ""
                    size = 0
                    
                    # Try Item field first (for SendAs, Send, MailItemsAccessed when Item present)
                    if "Item" in audit_data:
                        item = audit_data["Item"]
                        subject = subject or item.get("Subject", "")
                        folder = item.get("ParentFolder", {}).get("Path", "")
                        size = item.get("SizeInBytes", 0)
                    # Otherwise try AffectedItems (for HardDelete, SoftDelete, Move, etc.)
                    elif "AffectedItems" in audit_data and audit_data["AffectedItems"]:
                        affected_item = audit_data["AffectedItems"][0]
                        subject = subject or affected_item.get("Subject", "")
                        folder = affected_item.get("ParentFolder", {}).get("Path", "")
                        size = affected_item.get("SizeInBytes", 0)
                    
                    if subject or folder or size:
                        email_details = {
                            "timestamp": timestamp,
                            "subject": subject or "",
                            "folder": folder,
                            "size": size,
                        }
                        email_details_list.append(email_details)
                    
            except (json.JSONDecodeError, TypeError):
                pass
        
        if user:
            unique_mailboxes.add(user)
            if operation not in users_by_operation:
                users_by_operation[operation] = {}
            if user not in users_by_operation[operation]:
                users_by_operation[operation][user] = 0
            users_by_operation[operation][user] += 1
            
            # Store operation details for display in accordion
            if operation not in operation_details_by_type:
                operation_details_by_type[operation] = []
            
            # Add all email details extracted
            operation_details_by_type[operation].extend(email_details_list)

    exchange_stats["unique_mailboxes"] = len(unique_mailboxes)

    # Get operations by type
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

    # Build complete timeline of operations (chronological)
    detailed_ops = []
    for _, row in df.iterrows():
        operation = row.get("Operation", "Unknown")
        user = None
        if "MailboxOwnerUPN" in df.columns and pd.notna(row.get("MailboxOwnerUPN")):
            user = row.get("MailboxOwnerUPN")
        elif "UserId" in df.columns and pd.notna(row.get("UserId")):
            user = row.get("UserId")
        
        if "AuditData" in df.columns and pd.notna(row.get("AuditData")):
            try:
                audit_data = json.loads(row.get("AuditData", "{}"))
                timestamp = audit_data.get("CreationTime", "")
                
                # Special handling for MailItemsAccessed with Folders structure
                if operation == "MailItemsAccessed" and "Folders" in audit_data and audit_data["Folders"]:
                    # For timeline, limit to one representative item per operation
                    for folder_item in audit_data["Folders"]:
                        folder_path = folder_item.get("Path", "")
                        folder_items = folder_item.get("FolderItems", [])
                        
                        if folder_items and user:
                            # Only take the first item for timeline (performance)
                            item = folder_items[0]
                            detailed_ops.append({
                                "timestamp": timestamp,
                                "operation": operation,
                                "subject": item.get("Subject", ""),
                                "folder": folder_path,
                                "user": user,
                                "full_data": audit_data  # Ajouter les données complètes
                            })
                            # Only one item per operation in timeline
                            break
                # Special handling for New-InboxRule and Set-InboxRule
                elif operation in ["New-InboxRule", "Set-InboxRule"] and user:
                    parameters = audit_data.get("Parameters", [])
                    param_dict = {}
                    if isinstance(parameters, list):
                        for param in parameters:
                            if isinstance(param, dict):
                                param_dict[param.get("Name", "")] = param.get("Value", "")
                    
                    rule_name = param_dict.get("Name", "")
                    rule_from = param_dict.get("From", "")
                    
                    subject = f"Rule: {rule_name}" if rule_name else "Inbox Rule"
                    folder = f"From: {rule_from}" if rule_from else ""
                    
                    detailed_ops.append({
                        "timestamp": timestamp,
                        "operation": operation,
                        "subject": subject,
                        "folder": folder,
                        "user": user,
                        "full_data": audit_data  # Ajouter les données complètes
                    })
                else:
                    # Original logic for other operations
                    subject = audit_data.get("Subject", "")
                    folder = ""
                    
                    # Extract subject from Item or AffectedItems
                    if "Item" in audit_data:
                        subject = subject or audit_data["Item"].get("Subject", "")
                        folder = audit_data["Item"].get("ParentFolder", {}).get("Path", "")
                    elif "AffectedItems" in audit_data and audit_data["AffectedItems"]:
                        subject = subject or audit_data["AffectedItems"][0].get("Subject", "")
                        folder = audit_data["AffectedItems"][0].get("ParentFolder", {}).get("Path", "")
                    
                    if user:
                        detailed_ops.append({
                            "timestamp": timestamp,
                            "operation": operation,
                            "subject": subject,
                            "folder": folder,
                            "user": user,
                            "full_data": audit_data  # Ajouter les données complètes
                        })
                
            except (json.JSONDecodeError, TypeError):
                pass
    
    # Sort by timestamp (descending - most recent first)
    detailed_ops.sort(key=lambda x: x["timestamp"], reverse=True)
    
    # Apply detailed filters to operations timeline
    detailed_ops = filter_detailed_operations(detailed_ops, params)
    
    exchange_stats["detailed_operations"] = detailed_ops

    return exchange_stats

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
    app.run(host=host, port=port, debug=debug)


if __name__ == "__main__":
    run_flask_app(debug=True)
