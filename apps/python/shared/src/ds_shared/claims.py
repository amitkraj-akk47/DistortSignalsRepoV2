"""
Claims and validation utilities
"""

from typing import Dict, Any, List
from pydantic import BaseModel, ValidationError


class SignalClaim(BaseModel):
    """Signal data validation model"""
    signal_id: str
    symbol: str
    signal_type: str
    confidence: float
    price: float
    generated_at: str


class DirectiveClaim(BaseModel):
    """Directive data validation model"""
    directive_id: str
    signal_id: str
    symbol: str
    action: str
    order_type: str
    quantity: float
    issued_at: str


def validate_signal(data: Dict[str, Any]) -> SignalClaim:
    """
    Validate signal data
    
    Args:
        data: Signal data dictionary
    
    Returns:
        Validated SignalClaim
    
    Raises:
        ValidationError: If data is invalid
    """
    return SignalClaim(**data)


def validate_directive(data: Dict[str, Any]) -> DirectiveClaim:
    """
    Validate directive data
    
    Args:
        data: Directive data dictionary
    
    Returns:
        Validated DirectiveClaim
    
    Raises:
        ValidationError: If data is invalid
    """
    return DirectiveClaim(**data)
