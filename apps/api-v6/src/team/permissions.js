/** Fine-grained permissions mapped from coarse roles (roadmap-ready). */
export const Permission = {
  CatalogRead: 'catalog.read',
  CatalogWrite: 'catalog.write',
  OrdersRead: 'orders.read',
  OrdersWrite: 'orders.write',
  CustomersRead: 'customers.read',
  CustomersWrite: 'customers.write',
  StorefrontWrite: 'storefront.write',
  SettingsWrite: 'settings.write',
  IntegrationsWrite: 'integrations.write',
  SupportWrite: 'support.write',
  AnalyticsRead: 'analytics.read',
  PaymentsRead: 'payments.read',
  PaymentsWrite: 'payments.write',
  DeliveryWrite: 'delivery.write',
  TeamWrite: 'team.write',
};

const ROLE_PERMISSIONS = {
  viewer: [
    Permission.CatalogRead,
    Permission.OrdersRead,
    Permission.CustomersRead,
    Permission.AnalyticsRead,
    Permission.PaymentsRead,
  ],
  manager: [
    Permission.CatalogRead,
    Permission.CatalogWrite,
    Permission.OrdersRead,
    Permission.OrdersWrite,
    Permission.CustomersRead,
    Permission.CustomersWrite,
    Permission.StorefrontWrite,
    Permission.AnalyticsRead,
    Permission.PaymentsRead,
    Permission.PaymentsWrite,
    Permission.DeliveryWrite,
    Permission.SupportWrite,
  ],
  admin: Object.values(Permission),
  owner: Object.values(Permission),
};

export function permissionsForRole(role) {
  return [...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.viewer)];
}

export function hasPermission(role, permission) {
  if (role === 'owner' || role === 'admin') return true;
  return permissionsForRole(role).includes(permission);
}
