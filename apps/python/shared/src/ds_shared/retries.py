"""
Retry utilities with exponential backoff
"""

import asyncio
import logging
from typing import Callable, TypeVar, Any
from functools import wraps

T = TypeVar("T")

logger = logging.getLogger(__name__)


def with_exponential_backoff(
    max_retries: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    exponential_base: float = 2.0,
):
    """
    Decorator for async functions with exponential backoff retry
    
    Args:
        max_retries: Maximum number of retry attempts
        base_delay: Initial delay in seconds
        max_delay: Maximum delay in seconds
        exponential_base: Exponential growth factor
    """
    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        @wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            last_exception = None
            
            for attempt in range(max_retries + 1):
                try:
                    return await func(*args, **kwargs)
                except Exception as e:
                    last_exception = e
                    
                    if attempt == max_retries:
                        logger.error(
                            f"Max retries ({max_retries}) reached for {func.__name__}: {e}"
                        )
                        raise
                    
                    delay = min(base_delay * (exponential_base ** attempt), max_delay)
                    logger.warning(
                        f"Attempt {attempt + 1}/{max_retries} failed for {func.__name__}: {e}. "
                        f"Retrying in {delay:.2f}s..."
                    )
                    await asyncio.sleep(delay)
            
            raise last_exception  # Should never reach here
        
        return wrapper
    return decorator


async def retry_on_exception(
    func: Callable[..., T],
    *args: Any,
    max_retries: int = 3,
    base_delay: float = 1.0,
    **kwargs: Any,
) -> T:
    """
    Execute async function with retry logic
    
    Args:
        func: Async function to execute
        *args: Positional arguments for func
        max_retries: Maximum retry attempts
        base_delay: Initial delay between retries
        **kwargs: Keyword arguments for func
    
    Returns:
        Result of func
    
    Raises:
        Last exception if all retries fail
    """
    last_exception = None
    
    for attempt in range(max_retries + 1):
        try:
            return await func(*args, **kwargs)
        except Exception as e:
            last_exception = e
            
            if attempt < max_retries:
                delay = base_delay * (2 ** attempt)
                logger.warning(f"Retry attempt {attempt + 1}/{max_retries} after {delay}s")
                await asyncio.sleep(delay)
    
    raise last_exception
