import { runDialogueScenario } from '../tests/run-scenario';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { StudioData } from '../apps/backend/src/data';
import { dialogueScenarios } from '../tests/dialogue-scenarios';

const label = process.argv.includes('--baseline') ? 'before' : 'after';
const checksum = () =>
  createHash('sha256')
    .update(
      readdirSync('data')
        .sort()
        .map((f) => readFileSync('data/' + f))
        .join(''),
    )
    .digest('hex');
const before = checksum();
const data = new StudioData(process.cwd());
const scenarios = [];
for (const scenario of dialogueScenarios) {
  const result = await runDialogueScenario(data, scenario);
  console.log(
    `${result.passed ? 'PASS' : 'FAIL'} ${scenario.id} ${scenario.title}${result.passed ? '' : ' ' + result.errors.join('; ')}`,
  );
  scenarios.push(result);
}

const report = {
  testedAt: new Date().toISOString(),
  label,
  total: scenarios.length,
  passed: scenarios.filter((s) => s.passed).length,
  failed: scenarios.filter((s) => !s.passed).length,
  jsonUnchanged: before === checksum(),
  scenarios,
};
writeFileSync(`runtime/scenario-audit-${label}.json`, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    jsonUnchanged: report.jsonUnchanged,
  }),
);
if (report.failed || !report.jsonUnchanged) process.exitCode = 1;
