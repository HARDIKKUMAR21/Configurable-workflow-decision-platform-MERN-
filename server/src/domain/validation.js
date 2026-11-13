import { AppError } from './errors.js';

export function validateInput(schema, input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('Input must be a JSON object', 400, 'INVALID_INPUT');
  }
  for (const [field, definition] of Object.entries(schema)) {
    const value = input[field];
    if (value === undefined || value === null) {
      if (definition.required) errors.push(`${field} is required`);
      continue;
    }
    if (typeof value !== definition.type || (definition.type === 'number' && !Number.isFinite(value))) {
      errors.push(`${field} must be a ${definition.type}`);
      continue;
    }
    if (definition.minLength !== undefined && value.length < definition.minLength) errors.push(`${field} is too short`);
    if (definition.min !== undefined && value < definition.min) errors.push(`${field} must be at least ${definition.min}`);
    if (definition.max !== undefined && value > definition.max) errors.push(`${field} must be at most ${definition.max}`);
    if (definition.enum && !definition.enum.includes(value)) errors.push(`${field} has an unsupported value`);
  }
  for (const field of Object.keys(input)) {
    if (!Object.hasOwn(schema, field)) errors.push(`${field} is not allowed`);
  }
  if (errors.length) throw new AppError('Input validation failed', 400, 'INVALID_INPUT', errors);
}
