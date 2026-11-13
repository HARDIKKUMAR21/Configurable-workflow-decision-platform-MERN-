export class AppError extends Error {
  constructor(message, status = 500, code = 'INTERNAL_ERROR', details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class DependencyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DependencyError';
  }
}
