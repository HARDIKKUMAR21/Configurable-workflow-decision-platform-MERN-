const symbols = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', in: 'in' };
const inverseSymbols = { eq: '!=', neq: '=', gt: '<=', gte: '<', lt: '>=', lte: '>', in: 'not in' };
const headings = {
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  MANUAL_REVIEW: 'Manual review required',
  RETRY_PENDING: 'Retry pending'
};

function nameOf(field) {
  return field.split('.').at(-1);
}

function humanize(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('-', ' ').toLowerCase();
}

function valueOf(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function booleanPhrase(event) {
  if (event.operator !== 'eq' || event.expected !== true || typeof event.actual !== 'boolean') return null;
  const field = nameOf(event.dataRef);
  if (field.endsWith('Complete')) return `${humanize(field.slice(0, -'Complete'.length))} ${event.actual ? 'complete' : 'incomplete'}`;
  if (field.endsWith('Verified')) return `${humanize(field.slice(0, -'Verified'.length))} ${event.actual ? 'verified' : 'not verified'}`;
  return `${humanize(field)} ${event.actual ? 'true' : 'false'}`;
}

function branchPhrase(event) {
  const field = nameOf(event.dataRef);
  const matched = event.result === 'MATCHED';
  const threshold = event.routeOutcome === 'MANUAL_REVIEW' ? 'review threshold' : 'routing threshold';
  if (event.operator === 'gt') {
    return `${field} ${valueOf(event.actual)} ${matched ? 'above' : 'not above'} the ${valueOf(event.expected)} ${threshold}`;
  }
  return `${field} ${valueOf(event.actual)} ${matched ? symbols[event.operator] : inverseSymbols[event.operator]} ${valueOf(event.expected)} (${matched ? 'matched' : 'not matched'} route)`;
}

function rulePhrase(event) {
  if (event.result === 'SKIPPED') {
    const condition = event.condition;
    return `${humanize(event.ruleId)} not required (${nameOf(condition.field)} ${valueOf(event.conditionActual)} ${inverseSymbols[condition.op]} ${valueOf(condition.value)})`;
  }
  if (event.kind === 'branch') return branchPhrase(event);
  return booleanPhrase(event) || `${nameOf(event.dataRef)} ${valueOf(event.actual)} ${event.result === 'PASS' ? symbols[event.operator] : inverseSymbols[event.operator]} ${valueOf(event.expected)}`;
}

export function buildDecisionExplanation({ outcome, audit, events = [], failure, attempt, maxAttempts, review, previousExplanation }) {
  const trace = [...audit, ...events].filter((event) => event.type === 'RULE_EVALUATED');
  const prior = previousExplanation?.replace(/^[^:]+: /, '');
  const clauses = review && prior ? [prior] : trace.map(rulePhrase);
  if (failure) clauses.push(`${failure.stageId} failed: ${failure.message} (attempt ${attempt} of ${maxAttempts})`);
  if (review) clauses.push(`reviewed by ${review.operator}: ${review.note}`);
  const heading = review ? `${headings[outcome]} after manual review` : headings[outcome];
  return `${heading}: ${clauses.length ? clauses.join(', ') : 'no rules evaluated'}`;
}
