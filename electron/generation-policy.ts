export const CONFIRMATION_DELAYS_MS = [60000, 120000] as const;

export function recoveryCandidatesForTask(preferred: string | null, candidates: string[], ownedByOthers: string[] = []) {
  const excluded = new Set(ownedByOthers);
  return Array.from(new Set(preferred ? [preferred] : candidates)).filter(url => !excluded.has(url));
}

export function hasFormalGenerationAcknowledgement(text: string, modelLabel: string) {
  const compact = text.replace(/[\s*]+/g, "");
  const label = modelLabel.replace(/\s+/g, "");
  return compact.includes(`本次使用${label}生成`)
    && /预计等待|大约需要|视频生成好后|本次生成将消耗每日免费额度/.test(compact);
}

export function hasNewFormalGenerationAcknowledgement(current: string, baseline: string, modelLabel: string) {
  const compact = (text: string) => text.replace(/[\s*]+/g, "");
  const phrase = `本次使用${compact(modelLabel)}生成`;
  return hasFormalGenerationAcknowledgement(current, modelLabel)
    && compact(current).split(phrase).length > compact(baseline).split(phrase).length;
}

export interface ConfirmationPolicyInput {
  now: number;
  stableSince: number;
  lastConfirmationAt: number;
  confirmationCount: number;
  accepted: boolean;
  responding: boolean;
  hasDraft: boolean;
}

export function confirmationDelayRemaining(input: ConfirmationPolicyInput) {
  if (input.accepted || input.responding || input.hasDraft || input.confirmationCount >= 2) return null;
  const delay = CONFIRMATION_DELAYS_MS[input.confirmationCount];
  return Math.max(0, delay - (input.now - Math.max(input.stableSince, input.lastConfirmationAt)));
}

export function shouldAttemptShareRecovery(input: {
  generatedAt: number;
  lastRecoveryAt: number;
  now: number;
}) {
  return input.generatedAt > 0
    && input.now - input.generatedAt >= 120000
    && (input.lastRecoveryAt === 0 || input.now - input.lastRecoveryAt >= 60000);
}
