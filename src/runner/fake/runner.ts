import { loadSchemas } from '../../schema/registry.mjs';
import { ExecutionError } from '../types.js';
import { LocalRunner } from '../local/runner.js';
import { fakeLaunch } from './launch.mjs';

const schemas = loadSchemas();

export class FakeRunner extends LocalRunner {
  constructor(root: string) {
    super(root, { id: 'fake', version: '1',
      validate(request) {
        if (request.model) throw new ExecutionError('fake model is unsupported');
        if (request.reasoning) throw new ExecutionError('fake reasoning is unsupported');
        let value: unknown;
        try { value = JSON.parse(request.prompt); } catch { throw new ExecutionError('fake prompt must be fake-worker-input JSON'); }
        if (!schemas.validator('fake-worker-input')(value)) throw new ExecutionError('fake prompt violates fake-worker-input schema');
      },
      launch: (_request, dir) => fakeLaunch(dir),
    });
  }
}
