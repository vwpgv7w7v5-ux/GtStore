import type { AuditFields, Id, Money } from './common';
export interface Category extends AuditFields { id: Id; shopId: Id; name: string; slug: string; parentId?: Id; imageUrl?: string; sortOrder: number; active: boolean; }
export interface ProductImage { id: Id; url: string; alt?: string; sortOrder: number; }
export interface ProductVariant { id: Id; sku: string; name: string; barcode?: string; price: Money; compareAtPrice?: Money; cost?: Money; stock: number; reserved: number; attributes: Record<string,string>; imageIds: Id[]; active: boolean; }
export interface Product extends AuditFields { id: Id; shopId: Id; name: string; slug: string; description: string; categoryId?: Id; brand?: string; supplier?: string; tags: string[]; images: ProductImage[]; variants: ProductVariant[]; active: boolean; seoTitle?: string; seoDescription?: string; }
export interface CreateProductInput { name: string; slug?: string; description?: string; categoryId?: Id; brand?: string; supplier?: string; tags?: string[]; images?: Omit<ProductImage,'id'>[]; variants: Omit<ProductVariant,'id'|'reserved'>[]; active?: boolean; seoTitle?: string; seoDescription?: string; }
export interface ProductFilter { query?: string; categoryId?: Id; active?: boolean; inStock?: boolean; brand?: string; tag?: string; }
