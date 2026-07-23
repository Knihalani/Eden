/**
 * Clerk — Signal Black (gold action on near-black).
 * Card chrome owned by `.auth-card`.
 */

const clerkAppearance = {
  variables: {
    colorPrimary: "#E8B84A",
    colorBackground: "transparent",
    colorInputBackground: "#000000",
    colorInputText: "#FFFFFF",
    colorText: "#FFFFFF",
    colorTextSecondary: "#A1A1AA",
    colorTextOnPrimaryBackground: "#000000",
    colorDanger: "#E07A7A",
    colorSuccess: "#4ECF96",
    colorWarning: "#E0B45C",
    colorNeutral: "#A1A1AA",
    borderRadius: "0.5rem",
    fontFamily: "inherit",
    fontSize: "0.875rem",
    spacingUnit: "1rem",
  },
  elements: {
    rootBox: { width: "100%" },
    cardBox: {
      width: "100%",
      boxShadow: "none",
      borderRadius: "0",
      overflow: "visible",
    },
    card: {
      width: "100%",
      maxWidth: "none",
      margin: "0",
      padding: "0",
      backgroundColor: "transparent",
      border: "none",
      borderRadius: "0",
      boxShadow: "none",
      overflow: "visible",
    },
    headerTitle: {
      color: "#FFFFFF",
      textAlign: "center",
      fontWeight: "560",
      letterSpacing: "-0.02em",
      fontSize: "1.0625rem",
    },
    headerSubtitle: {
      color: "#A1A1AA",
      textAlign: "center",
      fontSize: "0.8125rem",
    },
    header: { marginBottom: "1rem" },
    main: { gap: "0.75rem" },
    formFieldLabel: {
      color: "#D4D4D8",
      fontSize: "0.75rem",
      letterSpacing: "0.02em",
      fontWeight: "500",
    },
    formFieldInput: {
      backgroundColor: "#000000",
      borderColor: "rgba(255,255,255,0.12)",
      color: "#FFFFFF",
      borderRadius: "0.5rem",
      height: "2.5rem",
    },
    formButtonPrimary: {
      backgroundColor: "#E8B84A",
      color: "#000000",
      fontWeight: "600",
      borderRadius: "0.5rem",
      height: "2.5rem",
      boxShadow: "none",
    },
    socialButtonsBlockButton: {
      backgroundColor: "#000000",
      borderColor: "rgba(255,255,255,0.12)",
      color: "#FFFFFF",
      borderRadius: "0.5rem",
      height: "2.5rem",
      boxShadow: "none",
    },
    socialButtonsBlockButtonText: {
      color: "#FFFFFF",
      fontWeight: "500",
    },
    dividerLine: { backgroundColor: "rgba(255,255,255,0.12)" },
    dividerText: { color: "#8B8B96" },
    footer: {
      background: "transparent",
      backgroundColor: "transparent",
      borderTop: "none",
      marginTop: "0.5rem",
      paddingTop: "0",
    },
    footerAction: { marginTop: "0.75rem" },
    footerActionLink: { color: "#E8B84A", fontWeight: "500" },
    footerActionText: { color: "#A1A1AA" },
    identityPreviewText: { color: "#FFFFFF" },
    identityPreviewEditButton: { color: "#E8B84A" },
    formFieldInputShowPasswordButton: { color: "#8B8B96" },
    formFieldErrorText: { color: "#E07A7A" },
    alertText: { color: "#FFFFFF" },
    formResendCodeLink: { color: "#E8B84A" },
    otpCodeFieldInput: {
      backgroundColor: "#000000",
      borderColor: "rgba(255,255,255,0.12)",
      color: "#FFFFFF",
      borderRadius: "0.5rem",
    },
  },
};

export { clerkAppearance };
export type { clerkAppearance as ClerkAppearance };
