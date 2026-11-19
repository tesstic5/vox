/**
 * Platform operators run Voxera itself; workspace owners run one workspace.
 * Cross-workspace privileges must never be inherited from a workspace role.
 * Configure VOXERA_OPERATOR_EMAILS explicitly, including for self-hosted use.
 * An empty allowlist means no operator, not every customer owner.
 * API keys are refused by the routes that use this check.
 */
export function operatorEmails(): string[] {
  return (process.env.VOXERA_OPERATOR_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformOperator(user: { email?: string; role?: string } | undefined): boolean {
  if (!user) return false;
  const operators = operatorEmails();
  return operators.length > 0 && operators.includes(String(user.email ?? '').trim().toLowerCase());
}
