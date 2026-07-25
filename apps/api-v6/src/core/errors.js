export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message); this.name = 'AppError'; this.code = code; this.status = status; this.details = details;
  }
}
export const assert = (condition, code, message, status = 400, details) => {
  if (!condition) throw new AppError(code, message, status, details);
};
export const errorPayload = (error, requestId) => {
  if (error instanceof AppError) return { error: { code: error.code, message: error.message, details: error.details }, requestId };
  return { error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера' }, requestId };
};
