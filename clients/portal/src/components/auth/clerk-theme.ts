// Clerk appearance config that maps the portal's dark-terminal CSS
// variables onto Clerk's own theme tokens. Used by <SignIn /> and
// <SignUp /> in the catch-all /sign-in/* and /sign-up/* pages so
// the Clerk-rendered UI matches the rest of the dark terminal
// aesthetic rather than Clerk's default light theme.
//
// Two layers of theming:
//   1. ``variables`` — Clerk's semantic tokens (colorPrimary,
//      colorBackground, etc.). These accept CSS color strings, so
//      we mirror our CSS-variable palette as hex. Clerk applies
//      these once at mount; if our palette shifts, the page will
//      pick up the new values on a hard reload.
//   2. ``elements`` — fine-grained DOM-level overrides for things
//      variables can't reach (focus rings matching --border-glow,
//      card border-radius matching --radius-lg, etc). Element
//      styles DO accept ``var(--token)`` references, so we use
//      CSS variables here for everything we can.
//
// We don't pin Clerk's `Appearance` type explicitly — Clerk's
// generic `<Theme>` param makes the named export hard to reach from
// `@clerk/nextjs` without a transitive dep, and the structural
// shape is stable. The `as const` here would over-narrow to literal
// strings, so we infer a regular object — if Clerk adds a required
// field, the structural mismatch surfaces at the
// `<SignIn appearance={...} />` call site.

const clerkAppearance = {
  variables: {
    colorPrimary: "#5B9EFF", // --accent (Terminal Blue)
    colorBackground: "#0F1419", // --bg-secondary (form card surface)
    colorInputBackground: "#0A0E14", // --bg-primary (input wells)
    colorInputText: "#E4ECF7", // --text-primary
    colorText: "#E4ECF7",
    colorTextSecondary: "#94A3B8", // --text-secondary
    colorTextOnPrimaryBackground: "#03060A", // --accent-foreground
    colorDanger: "#FF6B7A", // --error
    colorSuccess: "#5FE5A8", // --success
    colorWarning: "#FFB547", // --warning (amber — NOT error red)
    colorNeutral: "#94A3B8",
    colorShimmer: "#1A2332", // --border-subtle (skeleton placeholders)
    borderRadius: "0.75rem", // matches --radius-lg
    fontFamily: "inherit", // use the portal's font stack
    fontSize: "0.875rem",
    spacingUnit: "1rem",
  },
  elements: {
    // ---- Root container ----
    // Render Clerk's form inside a real card so the inputs, labels,
    // and button sit on a defined surface (matching AuthFormCard) —
    // otherwise the form fields float on bg-secondary and look raw.
    rootBox: {
      width: "100%",
    },
    card: {
      width: "100%",
      maxWidth: "420px",
      margin: "0 auto",
      padding: "2rem 1.75rem 1.5rem",
      // June 22 2026 — fully opaque surface. Prior
      // ``rgba(15, 20, 25, 0.85)`` blended with the brand-panel
      // background and made the card edge indistinguishable from
      // the form column behind it on bright monitors. Locked to
      // ``--bg-secondary`` so the card is unambiguously a defined
      // surface and every text element on it has a known contrast
      // floor (16:1 for ``--text-primary`` against this bg).
      backgroundColor: "var(--bg-secondary)",
      border: "1px solid var(--border-glow)",
      borderRadius: "var(--radius-xl)",
      // Inset ring + outer glow give the card a depth separator
      // so it doesn't blend into the form column even if the
      // brand-panel gradient behind it shares the same hue.
      boxShadow:
        "0 0 0 1px var(--bg-primary) inset, 0 0 48px rgba(0, 0, 0, 0.5)",
      overflow: "hidden",
    },
    cardBox: {
      width: "100%",
      padding: 0,
    },

    // ---- Header (logo + title) ----
    // Branded pages render their own eyebrow + H1 above the card.
    // Hiding Clerk's header avoids a dual-H1 a11y failure and the
    // generic "Create your account" / "Sign in" duplicate.
    header: {
      display: "none",
      marginBottom: 0,
      gap: 0,
    },
    headerTitle: {
      display: "none",
      color: "var(--text-primary)",
      fontSize: "1.5rem",
      fontWeight: 700,
      letterSpacing: "-0.02em",
      marginBottom: 0,
    },
    headerSubtitle: {
      // ``display: none`` would inherit Clerk's default ``color:
      // #212126`` (near-black) if Clerk re-renders it without the
      // rule, which is exactly the "black on black" complaint we
      // hit on June 21. Belt-and-suspenders: explicitly neutralise
      // the colour so a re-render can't revert to dark text on dark
      // surface.
      display: "none",
      color: "var(--text-primary)",
    },
    headerBackIcon: {
      color: "var(--text-muted)",
      "&:hover": { color: "var(--text-secondary)" },
    },

    // ---- Form fields ----
    formFieldLabel: {
      color: "var(--text-primary)",
      fontWeight: 500,
      fontSize: "0.875rem",
      marginBottom: "0.375rem",
    },
    formFieldInput: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      // Clerk defaults the input colour to ``#212126`` (near-black)
      // which is invisible on our dark surface — explicitly set
      // light text on every text-bearing element inside the card.
      color: "var(--text-primary)",
      caretColor: "var(--accent)",
      borderRadius: "var(--radius-md)",
      transition: "border-color var(--duration-fast), box-shadow var(--duration-fast)",
      "&:hover": { borderColor: "var(--border-strong)" },
      "&:focus": {
        borderColor: "transparent",
        boxShadow: "0 0 0 2px var(--border-glow)",
        outline: "none",
      },
      "&:disabled": {
        opacity: 0.5,
        cursor: "not-allowed",
      },
      // Clerk renders a ``placeholder`` attribute on the underlying
      // <input> — force the placeholder colour too so the helper
      // text ("Enter your email address") doesn't appear as dark
      // grey on near-black.
      "&::placeholder": {
        color: "var(--text-muted)",
        opacity: 1,
      },
    },
    formFieldInputGroup: {
      borderColor: "var(--border-default)",
      backgroundColor: "var(--bg-primary)",
      borderRadius: "var(--radius-md)",
    },
    formFieldAction: {
      color: "var(--accent)",
      fontWeight: 500,
      fontSize: "0.8125rem",
      "&:hover": { color: "var(--accent-hover)", textDecoration: "underline" },
    },
    formFieldInputShowPasswordButton: {
      color: "var(--text-muted)",
      "&:hover": { color: "var(--text-secondary)" },
    },
    formFieldHintText: {
      color: "var(--text-muted)",
      fontSize: "0.75rem",
      marginTop: "0.375rem",
    },
    formFieldErrorText: {
      color: "var(--error)",
      fontSize: "0.75rem",
      marginTop: "0.375rem",
    },
    formFieldSuccessText: {
      color: "var(--success)",
      fontSize: "0.75rem",
      marginTop: "0.375rem",
    },

    // ---- Primary button (Sign in / Sign up / Continue) ----
    formButtonPrimary: {
      backgroundColor: "var(--accent)",
      // Dark foreground (#03060A) on the light accent (#5B9EFF)
      // gives 7.5:1 — well above WCAG AA's 4.5:1 normal-text floor
      // and the highest-contrast combination available on this
      // surface. The user's "black on black" report was about
      // OTHER elements (placeholder text, Clerk defaults leaking
      // through), not the button itself; this combination has been
      // the dark-terminal standard since the June 2026 polish pass
      // and we keep it.
      color: "var(--accent-foreground)",
      fontWeight: 600,
      fontSize: "0.875rem",
      // 44px touch target (WCAG 2.5.5 / Apple HIG) on primary CTA.
      minHeight: "2.75rem",
      borderRadius: "var(--radius-md)",
      transition:
        "background-color var(--duration-fast), box-shadow var(--duration-fast), transform var(--duration-fast)",
      "&:hover": { backgroundColor: "var(--accent-hover)" },
      "&:active": { transform: "translateY(1px)" },
      "&:disabled": { opacity: 0.5, cursor: "not-allowed" },
      "&:focus": {
        boxShadow: "0 0 0 2px var(--border-glow)",
        outline: "none",
      },
      "&:focus-visible": {
        boxShadow: "0 0 0 2px var(--border-glow)",
        outline: "none",
      },
    },

    // ---- Secondary / social buttons ----
    socialButtons: {
      gap: "0.5rem",
    },
    socialButtonsBlockButton: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      color: "var(--text-primary)",
      borderRadius: "var(--radius-md)",
      fontWeight: 500,
      fontSize: "0.875rem",
      minHeight: "2.75rem",
      transition:
        "background-color var(--duration-fast), border-color var(--duration-fast)",
      "&:hover": {
        backgroundColor: "var(--bg-tertiary)",
        borderColor: "var(--border-strong)",
      },
      "&:focus": {
        boxShadow: "0 0 0 2px var(--border-glow)",
        outline: "none",
      },
      "&:focus-visible": {
        boxShadow: "0 0 0 2px var(--border-glow)",
        outline: "none",
      },
    },
    socialButtonIcon: {
      // Clerk ships each provider icon with both light + dark variants
      // and auto-switches via prefers-color-scheme. Filtering them
      // ourselves makes Google/GitHub/etc. look muddy — leave them
      // as Clerk renders them.
      filter: "none",
    },

    // ---- Divider between social and email form ----
    dividerLine: {
      backgroundColor: "var(--border-default)",
      height: "1px",
    },
    dividerText: {
      color: "var(--text-muted)",
      backgroundColor: "var(--bg-secondary)",
      fontSize: "0.6875rem",
      fontWeight: 500,
      textTransform: "uppercase",
      letterSpacing: "0.12em",
      padding: "0 0.75rem",
    },

    // ---- Footer links (e.g. "Don't have an account? Sign up") ----
    footerActionLink: {
      color: "var(--accent)",
      fontWeight: 600,
      "&:hover": { color: "var(--accent-hover)", textDecoration: "underline" },
    },
    footerActionText: {
      color: "var(--text-secondary)",
      fontSize: "0.8125rem",
    },
    footer: {
      paddingTop: "1.25rem",
      marginTop: "1.25rem",
      borderTop: "1px solid var(--border-subtle)",
    },

    // ---- Identity preview (when choosing which account to sign in as) ----
    identityPreview: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      borderRadius: "var(--radius-md)",
      "&:hover": { backgroundColor: "var(--bg-tertiary)" },
    },
    identityPreviewText: {
      color: "var(--text-primary)",
    },
    identityPreviewEditButton: {
      color: "var(--accent)",
      "&:hover": { color: "var(--accent-hover)" },
    },

    // ---- OTP / verification code inputs ----
    otpCodeField: {
      gap: "0.5rem",
    },
    otpCodeFieldInput: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      color: "var(--text-primary)",
      borderRadius: "var(--radius-md)",
      fontSize: "1.125rem",
      fontWeight: 600,
      "&:focus": {
        borderColor: "transparent",
        boxShadow: "0 0 0 2px var(--border-glow)",
        outline: "none",
      },
    },

    // ---- Alternative authentication methods (e.g. "Use another method") ----
    alternativeMethods: {
      gap: "0.5rem",
    },
    alternativeMethodButton: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      color: "var(--text-secondary)",
      borderRadius: "var(--radius-md)",
      "&:hover": {
        backgroundColor: "var(--bg-tertiary)",
        borderColor: "var(--border-strong)",
        color: "var(--text-primary)",
      },
    },
    alternativeMethodBlockButton: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      color: "var(--text-primary)",
      borderRadius: "var(--radius-md)",
      "&:hover": {
        backgroundColor: "var(--bg-tertiary)",
        borderColor: "var(--border-strong)",
      },
    },

    // ---- Error / alert banners ----
    alert: {
      backgroundColor: "var(--error-bg)",
      borderColor: "var(--error)",
      color: "var(--error)",
      borderRadius: "var(--radius-md)",
      fontSize: "0.8125rem",
    },
    alertText: {
      color: "var(--error)",
    },
    formFieldWarningText: {
      color: "var(--warning)",
      fontSize: "0.75rem",
    },

    // ---- Selects (e.g. phone-number country picker) ----
    select: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      color: "var(--text-primary)",
      borderRadius: "var(--radius-md)",
    },
    selectButton: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      color: "var(--text-primary)",
      "&:hover": { backgroundColor: "var(--bg-tertiary)" },
      "&:focus": {
        borderColor: "transparent",
        boxShadow: "0 0 0 2px var(--border-glow)",
        outline: "none",
      },
    },
    selectOptions: {
      backgroundColor: "var(--bg-secondary)",
      borderColor: "var(--border-default)",
      borderRadius: "var(--radius-md)",
      boxShadow: "0 10px 30px rgba(0, 0, 0, 0.4)",
    },
    selectOption: {
      color: "var(--text-primary)",
      "&:hover": { backgroundColor: "var(--bg-tertiary)" },
      "&[data-selected]": {
        backgroundColor: "var(--accent-faint)",
        color: "var(--accent)",
      },
    },

    // ---- Loading spinner + button spinner ----
    spinner: {
      color: "var(--accent)",
    },
    loading: {
      color: "var(--accent)",
    },
    formButtonReset: {
      color: "var(--text-muted)",
      "&:hover": { color: "var(--text-secondary)" },
    },

    // ---- Modal (for SSO / org switching inside the SignIn flow) ----
    modalBackdrop: {
      backgroundColor: "rgba(3, 6, 10, 0.75)",
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
    },
    modalContent: {
      backgroundColor: "var(--bg-secondary)",
      borderColor: "var(--border-default)",
      borderRadius: "var(--radius-xl)",
      boxShadow: "0 20px 60px rgba(0, 0, 0, 0.5)",
      color: "var(--text-primary)",
    },
    modalCloseButton: {
      color: "var(--text-muted)",
      "&:hover": { color: "var(--text-primary)" },
    },

    // ---- User preview (post-verification, before redirect) ----
    userPreview: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      borderRadius: "var(--radius-md)",
    },
    userPreviewText: {
      color: "var(--text-primary)",
    },
    userPreviewSecondaryIdentifier: {
      color: "var(--text-muted)",
    },

    // ---- Avatar ----
    avatarBox: {
      width: "2.25rem",
      height: "2.25rem",
    },

    // ---- Active session / device picker ----
    activeDevice: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      borderRadius: "var(--radius-md)",
      color: "var(--text-primary)",
    },
    deviceListItem: {
      // June 2026 contrast bump: was --border-subtle (2.1:1), now
      // --border-default (3.0:1) so device entries in the SSO /
      // session picker read as distinct cards against bg-secondary.
      borderColor: "var(--border-default)",
      "&:hover": { backgroundColor: "var(--bg-tertiary)" },
    },
  },
};

export { clerkAppearance };
export type { clerkAppearance as ClerkAppearance };