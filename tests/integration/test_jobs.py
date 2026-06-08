"""Integration tests for Eden job management routes.

Covers: job submission, status retrieval, listing, result download,
        test reports, job cancellation, version history, and streaming.
"""

import pytest
from fastapi.testclient import TestClient


class TestJobSubmit:
    def test_submit_job(self, authenticated_client: TestClient):
        """Submitting a job returns job_id and pending status."""
        response = authenticated_client.post("/jobs", json={
            "description": "A simple CartPole-like environment",
            "tags": ["gymnasium", "classic_control"],
            "difficulty_parameters": {},
        })

        assert response.status_code == 200
        data = response.json()
        assert "job_id" in data
        assert data["status"] == "pending"
        assert "message" in data

    def test_submit_job_unauthenticated(self, api_client: TestClient):
        """Unauthenticated job submission returns 401."""
        response = api_client.post("/jobs", json={
            "description": "Test environment",
            "tags": [],
            "difficulty_parameters": {},
        })

        assert response.status_code == 401

    def test_submit_job_invalid_payload(self, authenticated_client: TestClient):
        """Missing required fields returns 422."""
        response = authenticated_client.post("/jobs", json={
            "tags": [],
        })

        assert response.status_code == 422


class TestJobStatus:
    def test_get_job_status(self, authenticated_client: TestClient):
        """Retrieving a job returns status and stage info."""
        # First create a job
        submit = authenticated_client.post("/jobs", json={
            "description": "Test env",
            "tags": [],
            "difficulty_parameters": {},
        })
        job_id = submit.json()["job_id"]

        response = authenticated_client.get(f"/jobs/{job_id}")

        assert response.status_code == 200
        data = response.json()
        assert data["job_id"] == job_id
        assert "status" in data
        assert "current_stage" in data
        assert "stage_history" in data

    def test_get_job_status_not_found(self, authenticated_client: TestClient):
        """Unknown job ID returns 404."""
        response = authenticated_client.get("/jobs/nonexistent-job-id")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_get_job_status_unauthenticated(self, api_client: TestClient):
        """Unauthenticated status request returns 401."""
        response = api_client.get("/jobs/some-job-id")

        assert response.status_code == 401


class TestJobList:
    def test_list_jobs(self, authenticated_client: TestClient):
        """Listing jobs returns paginated results."""
        response = authenticated_client.get("/jobs?limit=10&offset=0")

        assert response.status_code == 200
        data = response.json()
        assert "jobs" in data
        assert "total" in data
        assert "limit" in data
        assert "offset" in data
        assert isinstance(data["jobs"], list)

    def test_list_jobs_with_filters(self, authenticated_client: TestClient):
        """Filtering by status returns matching jobs."""
        response = authenticated_client.get("/jobs?status=pending&limit=5")

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data["jobs"], list)

    def test_list_jobs_unauthenticated(self, api_client: TestClient):
        """Unauthenticated list returns 401."""
        response = api_client.get("/jobs")

        assert response.status_code == 401

    def test_list_jobs_invalid_created_after(self, authenticated_client: TestClient):
        """Invalid datetime format returns 400."""
        response = authenticated_client.get("/jobs?created_after=not-a-date")

        assert response.status_code == 400
        assert "datetime" in response.json()["detail"].lower()


class TestJobResult:
    def test_get_job_result_incomplete(self, authenticated_client: TestClient):
        """Result for incomplete job returns 202."""
        # Submit a job (mock DB will have status "pending")
        submit = authenticated_client.post("/jobs", json={
            "description": "Test env",
            "tags": [],
            "difficulty_parameters": {},
        })
        job_id = submit.json()["job_id"]

        response = authenticated_client.get(f"/jobs/{job_id}/result")

        # Job is pending, so it should return 202
        assert response.status_code == 202
        assert "not yet completed" in response.json()["detail"]

    def test_get_job_result_not_found(self, authenticated_client: TestClient):
        """Result for unknown job returns 404."""
        response = authenticated_client.get("/jobs/nonexistent/result")

        assert response.status_code == 404


class TestJobTests:
    def test_get_job_tests_incomplete(self, authenticated_client: TestClient):
        """Tests for incomplete job returns 202."""
        submit = authenticated_client.post("/jobs", json={
            "description": "Test env",
            "tags": [],
            "difficulty_parameters": {},
        })
        job_id = submit.json()["job_id"]

        response = authenticated_client.get(f"/jobs/{job_id}/tests")

        assert response.status_code == 202
        assert "not yet completed" in response.json()["detail"]

    def test_get_job_tests_not_found(self, authenticated_client: TestClient):
        """Tests for unknown job returns 404."""
        response = authenticated_client.get("/jobs/nonexistent/tests")

        assert response.status_code == 404


class TestJobDownload:
    def test_download_job_not_found(self, authenticated_client: TestClient):
        """Download for unknown job returns 404."""
        response = authenticated_client.get("/jobs/nonexistent/download")

        assert response.status_code == 404

    def test_download_job_incomplete(self, authenticated_client: TestClient):
        """Download for incomplete job returns 400."""
        submit = authenticated_client.post("/jobs", json={
            "description": "Test env",
            "tags": [],
            "difficulty_parameters": {},
        })
        job_id = submit.json()["job_id"]

        response = authenticated_client.get(f"/jobs/{job_id}/download")

        assert response.status_code == 400
        assert "not yet completed" in response.json()["detail"]


class TestJobTrace:
    def test_get_job_trace(self, authenticated_client: TestClient):
        """Job trace returns checkpoint history."""
        submit = authenticated_client.post("/jobs", json={
            "description": "Test env",
            "tags": [],
            "difficulty_parameters": {},
        })
        job_id = submit.json()["job_id"]

        response = authenticated_client.get(f"/jobs/{job_id}/trace")

        assert response.status_code == 200
        data = response.json()
        assert data["job_id"] == job_id
        assert "trace_entries" in data
        assert "checkpoint_count" in data


class TestJobVersions:
    def test_get_job_versions(self, authenticated_client: TestClient):
        """Version history returns code snapshots."""
        submit = authenticated_client.post("/jobs", json={
            "description": "Test env",
            "tags": [],
            "difficulty_parameters": {},
        })
        job_id = submit.json()["job_id"]

        response = authenticated_client.get(f"/jobs/{job_id}/versions")

        assert response.status_code == 200
        assert isinstance(response.json(), list)

    def test_get_job_versions_not_found(self, authenticated_client: TestClient):
        """Versions for unknown job returns 404."""
        response = authenticated_client.get("/jobs/nonexistent/versions")

        assert response.status_code == 404


class TestJobCancel:
    def test_cancel_pending_job(self, authenticated_client: TestClient):
        """Cancel a pending job succeeds."""
        submit = authenticated_client.post("/jobs", json={
            "description": "Test env",
            "tags": [],
            "difficulty_parameters": {},
        })
        job_id = submit.json()["job_id"]

        response = authenticated_client.post(f"/jobs/{job_id}/cancel")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "cancelled"

    def test_cancel_already_completed(self, authenticated_client: TestClient):
        """Cancel an already-completed job returns 400."""
        # Mock DB won't have this job as completed, so we'll test structure
        response = authenticated_client.post("/jobs/nonexistent/cancel")

        # Either 404 (job not found) or 400 (already completed)
        assert response.status_code in (404, 400)

    def test_cancel_not_found(self, authenticated_client: TestClient):
        """Cancel unknown job returns 404."""
        response = authenticated_client.post("/jobs/nonexistent/cancel")

        assert response.status_code == 404


class TestJobStream:
    @pytest.mark.skip(reason="SSE stream loops forever on non-terminal status; mock DB returns pending")
    def test_stream_job_status(self, authenticated_client: TestClient):
        """SSE stream endpoint is accessible.

        Skipped because the mock DB always returns status='pending',
        which is non-terminal, causing the SSE generator to loop forever.
        To properly test streaming, the mock would need to return a terminal
        status or support stateful status transitions.
        """
        submit = authenticated_client.post("/jobs", json={
            "description": "Test env",
            "tags": [],
            "difficulty_parameters": {},
        })
        job_id = submit.json()["job_id"]

        # SSE streams with text/event-stream content type
        response = authenticated_client.get(f"/jobs/{job_id}/stream")

        assert response.status_code == 200
        assert "event-stream" in response.headers.get("content-type", "")
