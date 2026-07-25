import type { Id } from './common';
export type StorefrontBlockType = 'heroCarousel'|'categoryTiles'|'productCollection'|'richText'|'spacer'|'announcement';
export interface StorefrontTheme { background: string; surface: string; primary: string; accent: string; text: string; mutedText: string; radius: number; fontFamily: string; }
export interface HeroSlide { id: Id; imageUrl: string; mobileImageUrl?: string; title?: string; subtitle?: string; actionLabel?: string; actionUrl?: string; }
export interface CategoryTile { id: Id; categoryId: Id; title: string; imageUrl: string; subtitle?: string; }
export interface StorefrontBlock { id: Id; type: StorefrontBlockType; enabled: boolean; sortOrder: number; title?: string; settings: Record<string,unknown>; }
export interface StorefrontDraft { id: Id; shopId: Id; name: string; theme: StorefrontTheme; blocks: StorefrontBlock[]; publishedVersion?: number; draftVersion: number; updatedAt: string; }
