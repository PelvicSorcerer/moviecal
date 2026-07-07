export type QuarantineEntry = {
  /** Playwright test id: `<relative-spec-path> > <test title>` */
  testId: string;
  reason: string;
  owner: string;
  trackingIssue: string;
  quarantinedAt: string;
};

export type QuarantineRegistry = {
  version: 1;
  entries: QuarantineEntry[];
};

export type PlaywrightQuarantineMode = 'blocking' | 'quarantine-only';

export type RuntimeFailureArtifactKind =
  | 'screenshot'
  | 'trace'
  | 'video'
  | 'failure-summary';

export type RuntimeFailureArtifact = {
  kind: RuntimeFailureArtifactKind;
  path: string;
};
