import fs from 'node:fs';
import path from 'node:path';

import type {
  PlaywrightQuarantineMode,
  QuarantineEntry,
  QuarantineRegistry,
} from './types';

export const DEFAULT_QUARANTINE_REGISTRY_PATH = 'e2e/quarantine.json';
export const QUARANTINE_TAG = '@quarantine';

function isQuarantineRegistry(value: unknown): value is QuarantineRegistry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<QuarantineRegistry>;

  return (
    candidate.version === 1 &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isQuarantineEntry)
  );
}

function isQuarantineEntry(value: unknown): value is QuarantineEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<QuarantineEntry>;

  return (
    typeof candidate.testId === 'string' &&
    candidate.testId.length > 0 &&
    typeof candidate.reason === 'string' &&
    candidate.reason.length > 0 &&
    typeof candidate.owner === 'string' &&
    candidate.owner.length > 0 &&
    typeof candidate.trackingIssue === 'string' &&
    candidate.trackingIssue.length > 0 &&
    typeof candidate.quarantinedAt === 'string' &&
    candidate.quarantinedAt.length > 0
  );
}

function normalizeSpecPath(specFile: string): string {
  return specFile.split(path.sep).join('/');
}

export function buildPlaywrightTestId(
  specFile: string,
  title: string,
): string {
  return `${normalizeSpecPath(specFile)} > ${title}`;
}

export function loadQuarantineRegistry(
  registryPath: string = DEFAULT_QUARANTINE_REGISTRY_PATH,
  cwd: string = process.cwd(),
): QuarantineRegistry {
  const absolutePath = path.resolve(cwd, registryPath);

  if (!fs.existsSync(absolutePath)) {
    return { version: 1, entries: [] };
  }

  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);

  if (!isQuarantineRegistry(parsed)) {
    throw new Error(
      `Invalid quarantine registry at ${registryPath}. Expected { version: 1, entries: [...] }.`,
    );
  }

  return parsed;
}

export function findQuarantineEntry(
  registry: QuarantineRegistry,
  testId: string,
): QuarantineEntry | undefined {
  return registry.entries.find((entry) => entry.testId === testId);
}

export function hasQuarantineTag(title: string): boolean {
  return title.includes(QUARANTINE_TAG);
}

export function isQuarantinedTest(args: {
  title: string;
  specFile: string;
  registry: QuarantineRegistry;
}): boolean {
  const testId = buildPlaywrightTestId(args.specFile, args.title);

  return (
    hasQuarantineTag(args.title) ||
    findQuarantineEntry(args.registry, testId) !== undefined
  );
}

export function resolveQuarantineMode(
  env: NodeJS.ProcessEnv = process.env,
): PlaywrightQuarantineMode {
  return env.PLAYWRIGHT_QUARANTINE_MODE === 'quarantine-only'
    ? 'quarantine-only'
    : 'blocking';
}

export function shouldRunTestInQuarantineMode(args: {
  mode: PlaywrightQuarantineMode;
  title: string;
  specFile: string;
  registry: QuarantineRegistry;
}): boolean {
  const quarantined = isQuarantinedTest({
    title: args.title,
    specFile: args.specFile,
    registry: args.registry,
  });

  if (args.mode === 'quarantine-only') {
    return quarantined;
  }

  return !quarantined;
}

export function getQuarantineSkipReason(
  registry: QuarantineRegistry,
  testId: string,
): string {
  const entry = findQuarantineEntry(registry, testId);

  if (entry) {
    return `Quarantined (${entry.trackingIssue}): ${entry.reason}`;
  }

  return 'Quarantined via @quarantine tag. See docs/planning/browser-runtime-test-stability.md.';
}
