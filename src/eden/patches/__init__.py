"""Salvaged patch pipeline modules (N20 / N23).

Core issue→patch→PR primitives retained after Cat 23 + F22 removal.
"""

from eden.patches.issue_patch_trigger import (
    propose_patch_for_action,
    propose_patch_for_issue,
)
from eden.patches.patch_generator import PatchGenerator
from eden.patches.policy import CodeChangePolicyService, get_org_code_change_policy
from eden.patches.pr_creator import PRCreator

__all__ = [
    "CodeChangePolicyService",
    "PatchGenerator",
    "PRCreator",
    "get_org_code_change_policy",
    "propose_patch_for_action",
    "propose_patch_for_issue",
]
