/** Domain facade (integrations) — K13. */
export type {
  A2AGraph,
  A2ALinkRow,
  GitHubInstallation,
  GitHubRepo,
  IntegrationStatusItem,
  OnboardingPRRun,
  OnboardingState,
  OnboardingV2State,
  OnboardingV2Step,
} from "./resources";
export {
  a2aApi,
  githubApi,
  integrationsApi,
  onboardingApi,
  onboardingV2Api,
} from "./resources";
