"""Eden coder subclasses.

``EdenCoder`` is the only coder in this package; it subclasses
``aider.coders.EditBlockCoder`` and registers with ``edit_format = "eden"``.
"""

from eden.coders.eden_coder import (
    EDIT_FORMAT,
    EdenCoder,
    EdenContextPayload,
    aider_import_error,
    is_aider_available,
    register_with_aider,
)

__all__ = [
    "EDIT_FORMAT",
    "EdenCoder",
    "EdenContextPayload",
    "is_aider_available",
    "aider_import_error",
    "register_with_aider",
]
