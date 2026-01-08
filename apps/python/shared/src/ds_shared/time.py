"""
Time utilities for consistent timezone handling
"""

from datetime import datetime, timezone
from typing import Optional


def utc_now() -> datetime:
    """
    Get current time in UTC with timezone info
    
    Returns:
        Current datetime in UTC
    """
    return datetime.now(timezone.utc)


def parse_iso_timestamp(timestamp: str) -> datetime:
    """
    Parse ISO 8601 timestamp string to datetime
    
    Args:
        timestamp: ISO 8601 formatted timestamp
    
    Returns:
        Parsed datetime object
    
    Raises:
        ValueError: If timestamp format is invalid
    """
    return datetime.fromisoformat(timestamp.replace('Z', '+00:00'))


def to_iso_timestamp(dt: datetime) -> str:
    """
    Convert datetime to ISO 8601 string
    
    Args:
        dt: Datetime object
    
    Returns:
        ISO 8601 formatted string
    """
    return dt.isoformat()


def time_ago_seconds(dt: datetime) -> float:
    """
    Calculate seconds elapsed since given datetime
    
    Args:
        dt: Past datetime (must be timezone-aware)
    
    Returns:
        Seconds elapsed
    
    Raises:
        TypeError: If datetime is not timezone-aware
    """
    if dt.tzinfo is None:
        raise TypeError("datetime must be timezone-aware")
    
    return (utc_now() - dt).total_seconds()


def is_expired(dt: datetime, max_age_seconds: float) -> bool:
    """
    Check if datetime is older than max_age_seconds
    
    Args:
        dt: Datetime to check
        max_age_seconds: Maximum age in seconds
    
    Returns:
        True if expired, False otherwise
    """
    return time_ago_seconds(dt) > max_age_seconds
