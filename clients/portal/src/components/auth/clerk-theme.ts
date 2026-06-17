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
// We don't import the ``Appearance`` type directly because
// @clerk/types isn't a declared dependency — @clerk/nextjs
// re-exports it, but typing it here would couple us to internal
// types that may shift across SDK versions. The structural shape
// is stable; if Clerk adds a required field, TypeScript will
// surface it at the <SignIn appearance={...} /> call site.

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
    // Drop Clerk's default background and card chrome so the form
    // blends into our AuthSplitLayout surface.
    rootBox: {
      width: "100%",
    },
    card: {
      backgroundColor: "transparent",
      boxShadow: "none",
      border: "none",
      padding: 0,
    },
    cardBox: {
      width: "100%",
    },

    // ---- Header (logo + title) ----
    headerTitle: {
      color: "var(--text-primary)",
      fontSize: "1.5rem",
      fontWeight: 700,
      letterSpacing: "-0.02em",
    },
    headerSubtitle: {
      color: "var(--text-muted)",
      fontSize: "0.875rem",
      lineHeight: 1.5,
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
      color: "var(--text-primary)",
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
      color: "var(--accent-foreground)",
      fontWeight: 600,
      fontSize: "0.875rem",
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
    },
    socialButtonIcon: {
      filter: "invert(0.85) hue-rotate(180deg)",
    },

    // ---- Divider between social and email form ----
    dividerLine: {
      backgroundColor: "var(--border-default)",
    },
    dividerText: {
      color: "var(--text-muted)",
      fontSize: "0.75rem",
      textTransform: "uppercase",
      letterSpacing: "0.1em",
    },

    // ---- Footer links (e.g. "Don't have an account? Sign up") ----
    footerActionLink: {
      color: "var(--accent)",
      fontWeight: 500,
      "&:hover": { color: "var(--accent-hover)", textDecoration: "underline" },
    },
    footerActionText: {
      color: "var(--text-secondary)",
    },
    footer: {
      paddingTop: "1rem",
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
    },
    deviceListItem: {
      borderColor: "var(--border-subtle)",
      "&:hover": { backgroundColor: "var(--bg-tertiary)" },
    },
  },
} as const;

export { clerkAppearance };