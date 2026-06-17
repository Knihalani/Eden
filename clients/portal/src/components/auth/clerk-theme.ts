// Clerk appearance config that maps the portal's dark-terminal CSS
// variables onto Clerk's own theme tokens. Used by <SignIn /> and
// <SignUp /> in the catch-all (auth)/*/[[...]]/page.tsx files so the
// Clerk-rendered UI matches the rest of the dark terminal aesthetic
// rather than Clerk's default light theme.
//
// Two layers of theming:
//   1. ``variables`` — Clerk's semantic tokens (colorPrimary,
//      colorBackground, etc.) read from our CSS variables so a
//      future palette swap propagates everywhere.
//   2. ``elements`` — fine-grained DOM-level overrides for things
//      variables can't reach (e.g. card border-radius matching our
//      --radius-lg, focus rings matching our --border-glow).
//
// We don't import the ``Appearance`` type directly because @clerk/types
// isn't a declared dependency — @clerk/nextjs re-exports it but typing
// it here would couple us to internal types that may shift across SDK
// versions. The structural shape is stable; if Clerk adds a required
// field, TypeScript will surface it at the <SignIn appearance={...} />
// call site.

const clerkAppearance = {
  variables: {
    colorPrimary: "#5B9EFF", // --accent
    colorBackground: "#0F1419", // --bg-secondary (the form card surface)
    colorInputBackground: "#0A0E14", // --bg-primary (input wells)
    colorInputText: "#E4ECF7", // --text-primary
    colorText: "#E4ECF7",
    colorTextSecondary: "#94A3B8", // --text-secondary
    colorTextOnPrimaryBackground: "#03060A", // --accent-foreground
    colorDanger: "#FF6B7A", // --error
    colorSuccess: "#5FE5A8", // --success
    colorWarning: "#FF6B7A",
    colorNeutral: "#94A3B8",
    colorShimmer: "#1A2332", // --border-subtle (skeleton placeholders)
    borderRadius: "0.75rem", // matches --radius-lg
    fontFamily: "inherit", // use the portal's font stack
    fontSize: "0.875rem",
    spacingUnit: "1rem",
  },
  elements: {
    // Root container — drop Clerk's default background and card chrome
    // so the form blends into our AuthFormCard surface.
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
    // Header (logo + title)
    headerTitle: {
      color: "var(--text-primary)",
      fontSize: "1.5rem",
      fontWeight: 700,
      letterSpacing: "-0.02em",
    },
    headerSubtitle: {
      color: "var(--text-muted)",
      fontSize: "0.875rem",
    },
    // Form fields — match Input component styling
    formFieldLabel: {
      color: "var(--text-primary)",
      fontWeight: 500,
      fontSize: "0.875rem",
    },
    formFieldInput: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      color: "var(--text-primary)",
      "&:focus": {
        borderColor: "transparent",
        boxShadow: "0 0 0 2px var(--border-glow)",
      },
    },
    formFieldInputShowPasswordButton: {
      color: "var(--text-muted)",
      "&:hover": { color: "var(--text-secondary)" },
    },
    formFieldHintText: {
      color: "var(--text-muted)",
      fontSize: "0.75rem",
    },
    formFieldErrorText: {
      color: "var(--error)",
      fontSize: "0.75rem",
    },
    formFieldSuccessText: {
      color: "var(--success)",
      fontSize: "0.75rem",
    },
    // Primary button (Sign in / Sign up / Continue)
    formButtonPrimary: {
      backgroundColor: "var(--accent)",
      color: "var(--accent-foreground)",
      fontWeight: 600,
      fontSize: "0.875rem",
      "&:hover": { backgroundColor: "var(--accent-hover)" },
      "&:disabled": { opacity: 0.5 },
      "&:focus": {
        boxShadow: "0 0 0 2px var(--border-glow)",
      },
    },
    // Secondary / social buttons
    socialButtons: {
      gap: "0.5rem",
    },
    socialButton: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      color: "var(--text-primary)",
      "&:hover": {
        backgroundColor: "var(--bg-tertiary)",
        borderColor: "var(--border-strong)",
      },
    },
    socialButtonIcon: {
      filter: "invert(0.85) hue-rotate(180deg)",
    },
    // Divider between social and email form
    dividerLine: {
      backgroundColor: "var(--border-default)",
    },
    dividerText: {
      color: "var(--text-muted)",
      fontSize: "0.75rem",
    },
    // Footer links (e.g. "Don't have an account? Sign up")
    footerActionLink: {
      color: "var(--accent)",
      fontWeight: 500,
      "&:hover": { textDecoration: "underline" },
    },
    footerActionText: {
      color: "var(--text-secondary)",
    },
    // Identity preview (when choosing which account to sign in as)
    identityPreview: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
    },
    identityPreviewText: {
      color: "var(--text-primary)",
    },
    identityPreviewEditButton: {
      color: "var(--accent)",
    },
    // OTP / verification code inputs
    otpCodeFieldInput: {
      backgroundColor: "var(--bg-primary)",
      borderColor: "var(--border-default)",
      color: "var(--text-primary)",
    },
    // Error / alert banners
    alert: {
      backgroundColor: "var(--error-bg)",
      borderColor: "var(--error)",
      color: "var(--error)",
    },
    alertText: {
      color: "var(--error)",
    },
    // Loading spinner
    spinner: {
      color: "var(--accent)",
    },
    // Modal (for SSO / org switching inside the SignIn flow)
    modalBackdrop: {
      backgroundColor: "rgba(3, 6, 10, 0.7)",
      backdropFilter: "blur(8px)",
    },
    modalContent: {
      backgroundColor: "var(--bg-secondary)",
      borderColor: "var(--border-default)",
    },
  },
} as const;

export { clerkAppearance };