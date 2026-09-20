import type { RunnerLocalLaunch } from '../../types/generated/index.js';
import type { RunRequest } from '../types.js';

/** Only adapters know backend flags. A persisted launch is consumed by the common supervisor. */
export interface LocalAdapter {
  id: string;
  version: string;
  capabilities?: { supportsResume: boolean; supportsLiveMessage: boolean };
  validate?(request: RunRequest): void;
  launch(request: RunRequest, dir: string): RunnerLocalLaunch;
}

export interface CliCommand { command: string; prefixArgs?: string[] }
