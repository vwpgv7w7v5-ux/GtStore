import type { RequestContext } from './types';
import { ForbiddenError } from '@gtstore/domain/errors';
export const Permission={CatalogRead:'catalog.read',CatalogWrite:'catalog.write',OrdersRead:'orders.read',OrdersWrite:'orders.write',CustomersRead:'customers.read',StorefrontWrite:'storefront.write',SettingsWrite:'settings.write',IntegrationsWrite:'integrations.write',SupportWrite:'support.write',AnalyticsRead:'analytics.read'} as const;
export function requirePermission(ctx:RequestContext,permission:string):void { if(!ctx.permissions.has(permission)&&!ctx.permissions.has('*')) throw new ForbiddenError(`Missing permission ${permission}`); }
export function assertShopScope(ctx:RequestContext,shopId:string):void { if(ctx.shopId&&ctx.shopId!==shopId) throw new ForbiddenError('Cross-shop access denied'); }
