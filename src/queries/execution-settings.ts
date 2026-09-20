import { resolveExecutionSettings } from '../settings/resolve.js';
import type { ExecutionSettingsSource, SettingsSelection } from '../settings/types.js';

export async function getExecutionSettings(ctx: { settings: ExecutionSettingsSource }, input: SettingsSelection & { workdir?: string }) {
  return resolveExecutionSettings(await ctx.settings.read(input.workdir), input);
}
