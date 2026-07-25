export class DomainError extends Error { constructor(public code:string, message:string, public details?:unknown){ super(message); this.name='DomainError'; } }
export class ValidationError extends DomainError { constructor(message:string, details?:unknown){ super('VALIDATION_ERROR',message,details); } }
export class NotFoundError extends DomainError { constructor(entity:string,id:string){ super('NOT_FOUND',`${entity} ${id} not found`); } }
export class ConflictError extends DomainError { constructor(message:string,details?:unknown){ super('CONFLICT',message,details); } }
export class ForbiddenError extends DomainError { constructor(message='Forbidden'){ super('FORBIDDEN',message); } }
