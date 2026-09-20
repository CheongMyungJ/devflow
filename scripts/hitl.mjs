import { createInterface } from 'node:readline/promises';
import { assemble } from './lib/assemble.mjs';
import { parseEntryArgs, report } from './lib/cli.mjs';

const { args, opts } = parseEntryArgs(process.argv.slice(2), {
  usage: 'usage: hitl <data-dir> <task-id> --runner-dir <dir> --actor human:<id> [--config <file>] [--machine-config <file>] [--question-backend codex] [--question-model <model>] [--question-reasoning <effort>]',
  positional: ['dataDir', 'taskId'], options: { 'runner-dir': { value: true, required: true }, actor: { value: true, required: true }, config: { value: true }, 'machine-config': { value: true }, 'project-config': { value: true }, 'question-backend': { value: true }, 'question-model': { value: true }, 'question-reasoning': { value: true } },
});
await report(async () => {
  const { commands, queries, ctx } = await assemble({ dataDir: args.dataDir, runnerDir: opts['runner-dir'], actor: opts.actor, config: opts.config, machineConfig: opts['machine-config'], projectConfig: opts['project-config'] });
  const ui = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let view = await queries.getWorkflow(ctx, args.taskId);
    while (true) {
      console.log(JSON.stringify(view, null, 2));
      if (!view.target) {
        if (!view.workflow) return 'execution workflow-start로 흐름을 시작하세요.';
        if (view.workflow.phase === 'ready_to_complete') return 'Planner done 제안을 확정했습니다. merge/Task 완료는 별도 절차입니다.';
        if (view.workflow.phase === 'paused') return '실행 중지 원인을 확인하세요. 종료 불명확 실행은 자동 대체하지 않습니다.';
        if ((await ui.question('Enter: 진행 상태 확인 / 0: 나가기 > ')).trim() === '0') return '종료';
        view = await commands.advance(ctx, { taskId: args.taskId }); continue;
      }
      console.log(view.notice);
      const choice = (await ui.question(`1: 승인 / 2: 수정 요청${view.target.role !== 'artifact' ? ' / 3: 질문 CLI 열기' : ''} / 0: 나가기 > `)).trim();
      if (choice === '0') return '종료';
      try {
        if (choice === '1') view = await commands.respondHitl(ctx, { taskId: args.taskId, target: view.target, response: 'approve' });
        else if (choice === '2') {
          const text = await ui.question('수정 요청 > ');
          let destination;
          if (view.target.role === 'reviewer') {
            const selected = (await ui.question('1: 코드·산출물 수정 / 2: 검토 판단 재검토 > ')).trim();
            if (!['1', '2'].includes(selected)) { console.log('대상을 선택하세요.'); continue; }
            destination = selected === '1' ? 'worker' : 'reviewer';
          }
          view = await commands.respondHitl(ctx, { taskId: args.taskId, target: view.target, response: 'revise', text, ...(destination ? { destination } : {}) });
        } else if (choice === '3' && view.target.role !== 'artifact') {
          const text = await ui.question('초기 질문 > ');
          const handoff = await commands.openQuestion(ctx, { taskId: args.taskId, target: view.target, text,
            ...(opts['question-backend'] ? { backend: opts['question-backend'] } : {}),
            ...(opts['question-model'] ? { model: opts['question-model'] } : {}),
            ...(opts['question-reasoning'] ? { reasoning: opts['question-reasoning'] } : {}) });
          console.log(JSON.stringify(handoff, null, 2));
          view = await queries.getWorkflow(ctx, args.taskId);
        }
      } catch (error) { console.error(error.message); view = await queries.getWorkflow(ctx, args.taskId); }
    }
  } finally { ui.close(); }
});
