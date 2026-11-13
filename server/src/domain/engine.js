import { DependencyError } from './errors.js';

function getValue(source, field) {
  const [root, key] = field.split('.');
  return Object.hasOwn(source[root], key) ? source[root][key] : undefined;
}

function compare(actual, op, expected) {
  switch (op) {
    case 'eq': return actual === expected;
    case 'neq': return actual !== expected;
    case 'gt': return typeof actual === 'number' && actual > expected;
    case 'gte': return typeof actual === 'number' && actual >= expected;
    case 'lt': return typeof actual === 'number' && actual < expected;
    case 'lte': return typeof actual === 'number' && actual <= expected;
    case 'in': return Array.isArray(expected) && expected.includes(actual);
    default: throw new Error(`Unsupported operator: ${op}`);
  }
}

export function evaluateRules(stage, input, context) {
  const source = { input, context };
  const trace = [];
  for (const rule of stage.rules) {
    if (rule.when) {
      const conditionActual = getValue(source, rule.when.field);
      if (!compare(conditionActual, rule.when.op, rule.when.value)) {
        trace.push({ ruleId: rule.id, kind: rule.kind || 'check', result: 'SKIPPED', condition: rule.when, conditionActual });
        continue;
      }
    }
    const actual = getValue(source, rule.field);
    const passed = compare(actual, rule.op, rule.value);
    const outcome = passed ? rule.onPass : rule.onFail;
    trace.push({
      ruleId: rule.id,
      kind: rule.kind || 'check',
      result: rule.kind === 'branch' ? (passed ? 'MATCHED' : 'NOT MATCHED') : (passed ? 'PASS' : 'FAIL'),
      dataRef: rule.field,
      actual,
      operator: rule.op,
      expected: rule.value,
      action: outcome || null,
      routeOutcome: rule.kind === 'branch' ? (rule.onPass || rule.onFail || null) : null,
      reason: outcome ? (rule.reason || null) : null
    });
    if (outcome) return { trace, outcome };
  }
  return { trace, outcome: null };
}

export async function simulateRiskScore({ input, attempt, operationKey }) {
  if (input.dependencyMode === 'fail-always' || (input.dependencyMode === 'fail-once' && attempt === 1)) {
    throw new DependencyError('Risk scoring service is temporarily unavailable');
  }
  const riskScore = Math.max(0, Math.min(100, Math.round((750 - input.creditScore) / 5 + input.amount / 5000)));
  return { riskScore, provider: 'simulated-risk-service', operationKey };
}

export async function executeStage(stage, request, adapters = { 'risk-score': simulateRiskScore }) {
  if (stage.type === 'rules') {
    const result = evaluateRules(stage, request.input, request.context);
    return { ...result, contextPatch: {} };
  }
  const operationKey = `${request.id}:${stage.id}`;
  const adapter = adapters[stage.adapter];
  if (!adapter) throw new Error(`Missing adapter: ${stage.adapter}`);
  const result = await adapter({ input: request.input, context: request.context, attempt: request.attempts, operationKey });
  if (!result || !Number.isFinite(result.riskScore) || result.riskScore < 0 || result.riskScore > 100) {
    throw new DependencyError('Risk scoring service returned an invalid response');
  }
  return {
    trace: [{ adapter: stage.adapter, result: 'SUCCESS', operationKey, output: result }],
    contextPatch: { riskScore: result.riskScore },
    outcome: null
  };
}
