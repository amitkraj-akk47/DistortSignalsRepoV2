"""
Database utilities for Supabase
"""

import os
from typing import Optional
from supabase import create_client, Client


_supabase_client: Optional[Client] = None


def get_supabase_client() -> Client:
    """
    Get or create Supabase client singleton
    
    Returns:
        Supabase client instance
    
    Raises:
        ValueError: If SUPABASE_URL or SUPABASE_KEY not set
    """
    global _supabase_client
    
    if _supabase_client is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_KEY")
        
        if not url or not key:
            raise ValueError("SUPABASE_URL and SUPABASE_KEY must be set")
        
        _supabase_client = create_client(url, key)
    
    return _supabase_client


def reset_client() -> None:
    """Reset the client singleton (useful for testing)"""
    global _supabase_client
    _supabase_client = None
