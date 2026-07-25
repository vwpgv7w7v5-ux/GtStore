export type Id = string;
export type ISODate = string;
export type CurrencyCode = 'RUB' | 'KZT' | 'USD' | 'EUR';
export type ChannelType = 'telegram' | 'max' | 'web' | 'api';
export type IntegrationType = 'moysklad' | 'one_c' | 'bitrix24' | 'custom_api';
export interface Money { amount: number; currency: CurrencyCode; }
export interface Pagination { page: number; pageSize: number; total: number; }
export interface Page<T> { items: T[]; pagination: Pagination; }
export interface AuditFields { createdAt: ISODate; updatedAt: ISODate; createdBy?: Id; updatedBy?: Id; }
export interface ApiErrorShape { code: string; message: string; fieldErrors?: Record<string,string[]>; requestId?: string; }
export interface ApiResponse<T> { data?: T; error?: ApiErrorShape; meta?: Record<string,unknown>; }
