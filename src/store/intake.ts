import type { IntakeDraft } from '../types/generated/index.js';

/** Pre-publication records share the State Store instance, not the Task lifecycle. */
export interface IntakeRepository {
  get(id: string): Promise<IntakeDraft | undefined>;
  put(value: IntakeDraft, expectedRevision: number): Promise<void>;
}
