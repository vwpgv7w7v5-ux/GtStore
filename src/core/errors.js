'use strict';
class AppError extends Error {
  constructor(message, status = 400, code = 'APP_ERROR', details = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
class NotFoundError extends AppError { constructor(message='Ресурс не найден'){ super(message,404,'NOT_FOUND'); } }
class ConflictError extends AppError { constructor(message='Конфликт данных'){ super(message,409,'CONFLICT'); } }
class ValidationError extends AppError { constructor(message='Ошибка проверки',details=null){ super(message,422,'VALIDATION_ERROR',details); } }
module.exports={AppError,NotFoundError,ConflictError,ValidationError};
