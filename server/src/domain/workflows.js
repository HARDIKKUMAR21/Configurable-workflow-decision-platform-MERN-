import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppError } from './errors.js';

const directory = fileURLToPath(new URL('../../config/workflows/', import.meta.url));
const operators = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']);
const outcomes = new Set(['APPROVED', 'REJECTED', 'MANUAL_REVIEW']);

function assertConfig(condition, message) {
  if (!condition) throw new Error(`Invalid workflow configuration: ${message}`);
}

function validateRule(rule, workflowKey) {
  assertConfig(typeof rule.id === 'string' && rule.id, `${workflowKey}: rule ID is missing`);
  assertConfig(/^(input|context)\.[A-Za-z][A-Za-z0-9]*$/.test(rule.field), `${workflowKey}: invalid field in ${rule.id}`);
  assertConfig(operators.has(rule.op), `${workflowKey}: unknown operator in ${rule.id}`);
  assertConfig(!rule.kind || ['check', 'branch'].includes(rule.kind), `${workflowKey}: unknown rule kind in ${rule.id}`);
  assertConfig(Object.hasOwn(rule, 'value'), `${workflowKey}: missing value in ${rule.id}`);
  for (const action of ['onPass', 'onFail']) {
    assertConfig(!rule[action] || outcomes.has(rule[action]), `${workflowKey}: invalid ${action} in ${rule.id}`);
  }
  if (rule.when) validatePredicate(rule.when, `${workflowKey}: ${rule.id} condition`);
}

function validatePredicate(predicate, label) {
  assertConfig(/^(input|context)\.[A-Za-z][A-Za-z0-9]*$/.test(predicate.field), `${label}: invalid field`);
  assertConfig(operators.has(predicate.op), `${label}: unknown operator`);
  assertConfig(Object.hasOwn(predicate, 'value'), `${label}: missing value`);
}

function validateWorkflow(workflow) {
  const key = `${workflow.id}@${workflow.version}`;
  assertConfig(typeof workflow.id === 'string' && workflow.id, 'ID is missing');
  assertConfig(Number.isInteger(workflow.version) && workflow.version > 0, `${key}: version must be positive`);
  assertConfig(workflow.input && typeof workflow.input === 'object', `${key}: input schema is missing`);
  assertConfig(Array.isArray(workflow.stages) && workflow.stages.length > 0, `${key}: stages are missing`);
  assertConfig(outcomes.has(workflow.defaultOutcome), `${key}: invalid default outcome`);
  if (workflow.retryPolicy) {
    assertConfig(Number.isInteger(workflow.retryPolicy.maxAttempts) && workflow.retryPolicy.maxAttempts > 0, `${key}: invalid maxAttempts`);
    assertConfig(Number.isInteger(workflow.retryPolicy.initialDelayMs) && workflow.retryPolicy.initialDelayMs > 0, `${key}: invalid initialDelayMs`);
  }
  const stageIds = new Set();
  for (const stage of workflow.stages) {
    assertConfig(typeof stage.id === 'string' && !stageIds.has(stage.id), `${key}: duplicate or missing stage ID`);
    stageIds.add(stage.id);
    assertConfig(['rules', 'dependency'].includes(stage.type), `${key}: unknown stage type`);
    if (stage.type === 'rules') {
      assertConfig(Array.isArray(stage.rules), `${key}: rules missing in ${stage.id}`);
      const ruleIds = new Set();
      for (const rule of stage.rules) {
        validateRule(rule, key);
        assertConfig(!ruleIds.has(rule.id), `${key}: duplicate rule ID ${rule.id}`);
        ruleIds.add(rule.id);
      }
    } else {
      assertConfig(stage.adapter === 'risk-score', `${key}: unknown dependency adapter`);
    }
  }
}

export function loadWorkflows() {
  const workflows = new Map();
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.json'))) {
    const workflow = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
    validateWorkflow(workflow);
    const key = `${workflow.id}@${workflow.version}`;
    assertConfig(!workflows.has(key), `duplicate workflow ${key}`);
    workflows.set(key, workflow);
  }
  return workflows;
}

export function getWorkflow(workflows, id, version) {
  const workflow = workflows.get(`${id}@${version}`);
  if (!workflow) throw new AppError('Unknown workflow or version', 404, 'WORKFLOW_NOT_FOUND');
  return workflow;
}

export function listWorkflows(workflows) {
  return [...workflows.values()].map(({ id, version, name, description, input, exampleInput }) => ({
    id, version, name, description, input, exampleInput
  }));
}
