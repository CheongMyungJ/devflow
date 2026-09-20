import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadSchemas } from '../../schema/registry.mjs';
import type { IntakeDraft } from '../../types/generated/index.js';
import type { IntakeRepository } from '../intake.js';
import { ConflictError, InvalidChangeError } from '../errors.js';
import type { FileOps } from './fs-ops.js';
import type { LockManager } from './lock.js';
const schemas = loadSchemas();

export class FileIntakeRepository implements IntakeRepository {
  constructor(private readonly root: string, private readonly ops: FileOps, private readonly locks: LockManager) {}
  private dir(id: string) { if (!/^I-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new InvalidChangeError('invalid Intake ID'); return join(this.root, 'intake', id); }
  async get(id: string): Promise<IntakeDraft | undefined> {
    const dir = this.dir(id);
    const names = (await this.ops.readdir(dir)).filter(n => /^v[1-9][0-9]*\.json$/.test(n)).sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
    if (!names.length) return undefined;
    if (names.some((n, i) => n !== `v${i + 1}.json`)) throw new InvalidChangeError('Intake revision history has a gap');
    const value = JSON.parse((await this.ops.readFile(join(dir, names.at(-1)!))).toString('utf8')) as IntakeDraft;
    if (!schemas.validator('intake-draft')(value) || value.id !== id || value.revision !== names.length) throw new InvalidChangeError('invalid Intake record');
    return value;
  }
  async put(value: IntakeDraft, expectedRevision: number): Promise<void> {
    if (!schemas.validator('intake-draft')(value) || value.revision !== expectedRevision + 1) throw new InvalidChangeError('invalid Intake revision');
    const dir = this.dir(value.id), lock = await this.locks.acquire(value.id);
    try {
      const current = await this.get(value.id);
      if ((current?.revision ?? 0) !== expectedRevision) throw new ConflictError(value.id, expectedRevision, current?.revision ?? 0);
      if (current && (value.events.length <= current.events.length || JSON.stringify(value.events.slice(0, current.events.length)) !== JSON.stringify(current.events))) throw new InvalidChangeError('Intake events are append-only');
      if (current) {
        if (current.phase === 'issued') throw new InvalidChangeError('Issued Intake is immutable');
        if (current.confirmed_intent && !isDeepStrictEqual(value.confirmed_intent, current.confirmed_intent)) throw new InvalidChangeError('Confirmed intent is immutable');
        if (value.turns.length < current.turns.length || value.turns.length > current.turns.length + 1) throw new InvalidChangeError('Intake turns are append-only');
        for (const [index, turn] of current.turns.entries()) {
          const next = value.turns[index]!;
          if (turn.status !== 'submitted') {
            if (!isDeepStrictEqual(next, turn)) throw new InvalidChangeError('Completed Intake turn is immutable');
          } else {
            const { status: _status, output: _output, failure: _failure, ended_at: _ended, ...frozen } = turn;
            const { status: _nextStatus, output: _nextOutput, failure: _nextFailure, ended_at: _nextEnded, ...nextFrozen } = next;
            if (!isDeepStrictEqual(frozen, nextFrozen)) throw new InvalidChangeError('Submitted Intake input is immutable');
            if (value.turns.length !== current.turns.length) throw new InvalidChangeError('Collect the submitted Intake turn first');
          }
        }
      }
      await this.ops.mkdir(dir, true);
      const temp = join(dir, `.pending-${randomUUID()}`), target = join(dir, `v${value.revision}.json`);
      await this.ops.writeFile(temp, JSON.stringify(value) + '\n');
      // Publish one immutable snapshot containing state and events, never an in-place append.
      await this.ops.rename(temp, target);
    } finally { await lock.release(); }
  }
}
