"""Unit tests for SCIM PatchOp parsing (RFC 7644 / Azure AD)."""

from __future__ import annotations

from eden.api.routes.scim import apply_scim_patch_operations


def _base_user(**overrides):
    user = {
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
        "id": "scim-1",
        "userName": "alice@example.com",
        "name": {"givenName": "Alice", "familyName": "Example"},
        "displayName": "Alice Example",
        "emails": [{"value": "alice@example.com", "type": "work", "primary": True}],
        "active": True,
    }
    user.update(overrides)
    return user


class TestApplyScimPatchOperations:
    def test_replace_active_false_string_azure(self):
        """Azure AD sends Replace + string 'False' for soft-delete."""
        current = _base_user()
        apply_scim_patch_operations(
            current,
            [{"op": "Replace", "path": "active", "value": "False"}],
        )
        assert current["active"] is False

    def test_replace_active_true_bool(self):
        current = _base_user(active=False)
        apply_scim_patch_operations(
            current,
            [{"op": "replace", "path": "active", "value": True}],
        )
        assert current["active"] is True

    def test_replace_name_subattributes(self):
        current = _base_user()
        apply_scim_patch_operations(
            current,
            [
                {"op": "replace", "path": "name.givenName", "value": "Alicia"},
                {"op": "replace", "path": "name.familyName", "value": "Smith"},
            ],
        )
        assert current["name"]["givenName"] == "Alicia"
        assert current["name"]["familyName"] == "Smith"
        assert current["displayName"] == "Alice Example"  # unchanged unless patched

    def test_replace_name_object(self):
        current = _base_user()
        apply_scim_patch_operations(
            current,
            [
                {
                    "op": "replace",
                    "path": "name",
                    "value": {"givenName": "Bob", "familyName": "Jones"},
                }
            ],
        )
        assert current["name"]["givenName"] == "Bob"
        assert current["name"]["familyName"] == "Jones"

    def test_replace_emails_list(self):
        current = _base_user()
        apply_scim_patch_operations(
            current,
            [
                {
                    "op": "replace",
                    "path": "emails",
                    "value": [
                        {"value": "new@example.com", "type": "work", "primary": True}
                    ],
                }
            ],
        )
        assert current["emails"][0]["value"] == "new@example.com"

    def test_replace_emails_filter_path(self):
        current = _base_user()
        apply_scim_patch_operations(
            current,
            [
                {
                    "op": "replace",
                    "path": 'emails[type eq "work"].value',
                    "value": "work@example.com",
                }
            ],
        )
        assert current["emails"][0]["value"] == "work@example.com"

    def test_pathless_replace_partial_resource(self):
        current = _base_user()
        apply_scim_patch_operations(
            current,
            [
                {
                    "op": "replace",
                    "value": {
                        "active": False,
                        "name": {"givenName": "Patched"},
                    },
                }
            ],
        )
        assert current["active"] is False
        assert current["name"]["givenName"] == "Patched"
        assert current["name"]["familyName"] == "Example"

    def test_ignores_non_replace_ops(self):
        current = _base_user()
        apply_scim_patch_operations(
            current,
            [{"op": "add", "path": "active", "value": False}],
        )
        assert current["active"] is True
