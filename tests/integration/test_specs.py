"""Integration tests for Eden spec and interview routes.

Covers: interview turn submission, spec generation, spec retrieval,
        spec listing, and spec-to-job conversion.
"""

import pytest
from fastapi.testclient import TestClient


class TestSpecInterview:
    def test_interview_turn_new_session(self, authenticated_client: TestClient, mock_interviewer_agent):
        """Starting a new interview creates a session."""
        response = authenticated_client.post("/specs/interview", json={
            "message": "I need an environment for testing multi-agent systems",
        })

        assert response.status_code == 200
        data = response.json()
        assert "session_id" in data
        assert "assistant_message" in data
        assert "checklist_state" in data
        assert "readiness_score" in data
        assert isinstance(data["is_ready_for_spec"], bool)

    def test_interview_turn_existing_session(self, authenticated_client: TestClient, mock_interviewer_agent):
        """Continuing an existing interview uses the same session."""
        # First turn
        r1 = authenticated_client.post("/specs/interview", json={
            "message": "I need a multi-agent environment",
        })
        session_id = r1.json()["session_id"]

        # Second turn with session_id
        r2 = authenticated_client.post("/specs/interview", json={
            "session_id": session_id,
            "message": "It should have 4 agents and sparse rewards",
        })

        assert r2.status_code == 200
        assert r2.json()["session_id"] == session_id

    def test_interview_turn_invalid_session(self, authenticated_client: TestClient, mock_interviewer_agent):
        """Unknown session ID creates a new session."""
        response = authenticated_client.post("/specs/interview", json={
            "session_id": "nonexistent-session",
            "message": "Hello",
        })

        # Should create a new session rather than fail
        assert response.status_code == 200
        assert "session_id" in response.json()

    def test_interview_unauthenticated(self, api_client: TestClient):
        """Interview without auth returns 401."""
        response = api_client.post("/specs/interview", json={
            "message": "Hello",
        })

        assert response.status_code == 401


class TestSpecGenerate:
    def test_generate_spec_from_session(self, authenticated_client: TestClient, mock_interviewer_agent):
        """Generating a spec from an interview session stores it."""
        # Start an interview
        interview = authenticated_client.post("/specs/interview", json={
            "message": "I need a multi-agent environment with 4 agents",
        })
        session_id = interview.json()["session_id"]

        response = authenticated_client.post(f"/specs/{session_id}/generate")

        assert response.status_code == 200
        data = response.json()
        assert "spec_id" in data
        assert "spec_data" in data
        assert data["status"] == "generated"

    def test_generate_spec_invalid_session(self, authenticated_client: TestClient, mock_interviewer_agent):
        """Generating from unknown session returns 404."""
        response = authenticated_client.post("/specs/nonexistent/generate")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()


class TestSpecRegenerate:
    def test_regenerate_spec_with_feedback(self, authenticated_client: TestClient, mock_interviewer_agent):
        """Regenerating a spec with feedback creates a new version."""
        # Start and generate first
        interview = authenticated_client.post("/specs/interview", json={
            "message": "I need a multi-agent environment",
        })
        session_id = interview.json()["session_id"]

        authenticated_client.post(f"/specs/{session_id}/generate")

        # Regenerate with feedback
        response = authenticated_client.post(f"/specs/{session_id}/regenerate", json={
            "feedback": "Add support for continuous actions",
        })

        assert response.status_code == 200
        data = response.json()
        assert "spec_id" in data
        assert data["version"] == 2


class TestSpecGet:
    def test_get_spec(self, authenticated_client: TestClient):
        """Retrieving a spec by ID returns its data."""
        # Create a spec first
        interview = authenticated_client.post("/specs/interview", json={
            "message": "I need an environment",
        })
        session_id = interview.json()["session_id"]
        gen = authenticated_client.post(f"/specs/{session_id}/generate")
        spec_id = gen.json()["spec_id"]

        response = authenticated_client.get(f"/specs/{spec_id}")

        assert response.status_code == 200
        data = response.json()
        assert data["spec_id"] == spec_id
        assert "spec_data" in data

    def test_get_spec_not_found(self, authenticated_client: TestClient):
        """Unknown spec ID returns 404."""
        response = authenticated_client.get("/specs/nonexistent-spec")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()


class TestSpecList:
    def test_list_specs(self, authenticated_client: TestClient):
        """Listing specs returns paginated results."""
        response = authenticated_client.get("/specs?limit=10&offset=0")

        assert response.status_code == 200
        data = response.json()
        assert "specs" in data
        assert "total" in data
        assert "limit" in data
        assert "offset" in data
        assert isinstance(data["specs"], list)

    def test_list_specs_with_status_filter(self, authenticated_client: TestClient):
        """Filtering by status returns matching specs."""
        response = authenticated_client.get("/specs?status=generated&limit=5")

        assert response.status_code == 200
        assert isinstance(response.json()["specs"], list)

    def test_list_specs_unauthenticated(self, api_client: TestClient):
        """Unauthenticated list returns 401."""
        response = api_client.get("/specs")

        assert response.status_code == 401


class TestSpecConvertToJob:
    def test_convert_spec_to_job(self, authenticated_client: TestClient):
        """Converting a spec to a job creates a pipeline job."""
        # Create a spec
        interview = authenticated_client.post("/specs/interview", json={
            "message": "I need an environment for testing agents",
        })
        session_id = interview.json()["session_id"]
        gen = authenticated_client.post(f"/specs/{session_id}/generate")
        spec_id = gen.json()["spec_id"]

        response = authenticated_client.post(f"/specs/{spec_id}/convert-to-job")

        assert response.status_code == 200
        data = response.json()
        assert "job_id" in data
        assert data["status"] == "pending"
        assert "message" in data

    def test_convert_spec_not_found(self, authenticated_client: TestClient):
        """Converting unknown spec returns 404."""
        response = authenticated_client.post("/specs/nonexistent/convert-to-job")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_convert_spec_unauthenticated(self, api_client: TestClient):
        """Unauthenticated conversion returns 401."""
        response = api_client.post("/specs/spec-123/convert-to-job")

        assert response.status_code == 401
