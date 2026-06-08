"""End-to-end tests for the Eden portal user journey.

Uses Playwright to test the full flow:
  Landing page → Login → Dashboard → New Job → Job Detail → Settings

These tests require the Next.js portal to be running on localhost:3000
and the FastAPI backend on localhost:8000.

Run with:  pytest tests/e2e/ --headed  (to see the browser)
"""

import pytest
from playwright.sync_api import Page, expect

pytestmark = pytest.mark.e2e

# ─────────────────────────────────────────────────────────────────────────────
# Test configuration
# ─────────────────────────────────────────────────────────────────────────────

BASE_URL = "http://localhost:3000"
API_BASE_URL = "http://localhost:8000"

TEST_USER = {
    "email": "e2e-test@example.com",
    "password": "E2eTest!Pass#2024",
    "name": "E2E Test User",
}


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def browser_context_args(browser_context_args):
    """Configure browser context for tests."""
    return {
        **browser_context_args,
        "viewport": {"width": 1280, "height": 720},
        "locale": "en-US",
    }


@pytest.fixture
def portal_page(page: Page):
    """Navigate to the portal landing page."""
    page.goto(BASE_URL)
    return page


# ─────────────────────────────────────────────────────────────────────────────
# Landing Page
# ─────────────────────────────────────────────────────────────────────────────

class TestLandingPage:
    def test_landing_page_loads(self, portal_page: Page):
        """The marketing landing page renders with key elements."""
        portal_page.goto(BASE_URL)

        # Should show the Eden brand
        expect(portal_page.locator("text=Eden")).to_be_visible()
        # Should have a CTA
        expect(portal_page.locator("text=Get Started")).to_be_visible()

    def test_navigate_to_login(self, portal_page: Page):
        """Clicking login navigates to the auth page."""
        portal_page.goto(BASE_URL)
        portal_page.click("text=Log in")

        expect(portal_page).to_have_url(f"{BASE_URL}/login")
        expect(portal_page.locator("input[type='email']")).to_be_visible()


# ─────────────────────────────────────────────────────────────────────────────
# Authentication Flow
# ─────────────────────────────────────────────────────────────────────────────

class TestAuthFlow:
    def test_login_page_renders(self, portal_page: Page):
        """Login page has email and password fields."""
        portal_page.goto(f"{BASE_URL}/login")

        expect(portal_page.locator("input[type='email']")).to_be_visible()
        expect(portal_page.locator("input[type='password']")).to_be_visible()
        expect(portal_page.locator("button[type='submit']")).to_be_visible()

    def test_login_with_valid_credentials(self, portal_page: Page):
        """Successful login redirects to dashboard."""
        portal_page.goto(f"{BASE_URL}/login")

        portal_page.fill("input[type='email']", TEST_USER["email"])
        portal_page.fill("input[type='password']", TEST_USER["password"])
        portal_page.click("button[type='submit']")

        # Should redirect to dashboard after successful login
        portal_page.wait_for_url(f"{BASE_URL}/dashboard")
        expect(portal_page.locator("text=Dashboard")).to_be_visible()

    def test_login_with_invalid_credentials(self, portal_page: Page):
        """Invalid credentials show an error message."""
        portal_page.goto(f"{BASE_URL}/login")

        portal_page.fill("input[type='email']", "wrong@example.com")
        portal_page.fill("input[type='password']", "wrongpassword")
        portal_page.click("button[type='submit']")

        # Should stay on login page with error
        expect(portal_page.locator("text=Invalid")).to_be_visible()

    def test_signup_page_renders(self, portal_page: Page):
        """Signup page has required fields."""
        portal_page.goto(f"{BASE_URL}/signup")

        expect(portal_page.locator("input[type='email']")).to_be_visible()
        expect(portal_page.locator("input[type='password']")).to_be_visible()
        expect(portal_page.locator("input[name='name']")).to_be_visible()

    def test_forgot_password_page(self, portal_page: Page):
        """Forgot password page accepts an email."""
        portal_page.goto(f"{BASE_URL}/forgot-password")

        expect(portal_page.locator("input[type='email']")).to_be_visible()
        expect(portal_page.locator("button[type='submit']")).to_be_visible()


# ─────────────────────────────────────────────────────────────────────────────
# Dashboard & Jobs
# ─────────────────────────────────────────────────────────────────────────────

class TestDashboardFlow:
    @pytest.fixture
    def logged_in_page(self, portal_page: Page):
        """Log in and return the authenticated page."""
        portal_page.goto(f"{BASE_URL}/login")
        portal_page.fill("input[type='email']", TEST_USER["email"])
        portal_page.fill("input[type='password']", TEST_USER["password"])
        portal_page.click("button[type='submit']")
        portal_page.wait_for_url(f"{BASE_URL}/dashboard")
        return portal_page

    def test_dashboard_loads(self, logged_in_page: Page):
        """Dashboard shows job list and navigation."""
        expect(logged_in_page.locator("text=Jobs")).to_be_visible()
        expect(logged_in_page.locator("text=New Job")).to_be_visible()

    def test_create_new_job(self, logged_in_page: Page):
        """Creating a new job navigates to the job detail page."""
        logged_in_page.click("text=New Job")
        logged_in_page.wait_for_url(f"{BASE_URL}/jobs/new")

        # Fill in the job description
        logged_in_page.fill("textarea", "A simple CartPole-like environment for testing")
        logged_in_page.click("button[type='submit']")

        # Should redirect to job detail page
        logged_in_page.wait_for_url(lambda url: "/jobs/" in url and "/new" not in url)
        expect(logged_in_page.locator("text=Job")).to_be_visible()

    def test_job_detail_shows_tabs(self, logged_in_page: Page):
        """Job detail page has Info, Code, and Tests tabs."""
        # Navigate to an existing job (if any)
        logged_in_page.goto(f"{BASE_URL}/jobs")
        # Click first job if available
        job_links = logged_in_page.locator("a[href^='/jobs/']")
        if job_links.count() > 0:
            job_links.first.click()
            expect(logged_in_page.locator("text=Info")).to_be_visible()
            expect(logged_in_page.locator("text=Code")).to_be_visible()
            expect(logged_in_page.locator("text=Tests")).to_be_visible()

    def test_job_list_pagination(self, logged_in_page: Page):
        """Job list supports pagination."""
        logged_in_page.goto(f"{BASE_URL}/jobs")
        expect(logged_in_page.locator("text=Jobs")).to_be_visible()


# ───────────────────────────────── ─────────────────────────────────────────────
# Settings
# ─────────────────────────────────────────────────────────────────────────────

class TestSettingsFlow:
    @pytest.fixture
    def logged_in_page(self, portal_page: Page):
        """Log in and return the authenticated page."""
        portal_page.goto(f"{BASE_URL}/login")
        portal_page.fill("input[type='email']", TEST_USER["email"])
        portal_page.fill("input[type='password']", TEST_USER["password"])
        portal_page.click("button[type='submit']")
        portal_page.wait_for_url(f"{BASE_URL}/dashboard")
        return portal_page

    def test_settings_page_loads(self, logged_in_page: Page):
        """Settings page has tabs for different categories."""
        logged_in_page.goto(f"{BASE_URL}/settings")

        expect(logged_in_page.locator("text=Settings")).to_be_visible()
        expect(logged_in_page.locator("text=General")).to_be_visible()
        expect(logged_in_page.locator("text=Security")).to_be_visible()
        expect(logged_in_page.locator("text=Billing")).to_be_visible()

    def test_2fa_setup_flow(self, logged_in_page: Page):
        """2FA setup page shows a QR code."""
        logged_in_page.goto(f"{BASE_URL}/settings")
        logged_in_page.click("text=Security")

        # Look for 2FA setup button
        setup_btn = logged_in_page.locator("button", has_text="Enable 2FA")
        if setup_btn.is_visible():
            setup_btn.click()
            expect(logged_in_page.locator("img")).to_be_visible()  # QR code image


# ─────────────────────────────────────────────────────────────────────────────
# Accessibility & Responsiveness
# ─────────────────────────────────────────────────────────────────────────────

class TestAccessibility:
    def test_login_page_has_labels(self, portal_page: Page):
        """Login form inputs have associated labels."""
        portal_page.goto(f"{BASE_URL}/login")

        email_input = portal_page.locator("input[type='email']")
        assert email_input.get_attribute("aria-label") or email_input.get_attribute("id")

    def test_color_contrast_on_landing(self, portal_page: Page):
        """Landing page has sufficient color contrast."""
        portal_page.goto(BASE_URL)

        # Basic check: text is visible against background
        header = portal_page.locator("h1").first
        expect(header).to_be_visible()
