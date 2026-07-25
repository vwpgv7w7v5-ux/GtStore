import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { JsonStore } from "./core/store.js";
import { AuthService } from "./auth/service.js";
import { TenancyService } from "./tenancy/service.js";
import { CatalogService } from "./catalog/service.js";
import { Router, json, readJson } from "./http/router.js";
import { errorPayload } from "./core/errors.js";
import { id } from "./core/ids.js";
import { MediaService } from "./media/service.js";
import { ImportService } from "./imports/service.js";
import { StorefrontService } from "./storefront/service.js";
import { OrderService } from "./orders/service.js";
import { TelegramService } from "./telegram/service.js";
import { TelegramCustomerService } from "./telegram/customer-service.js";
import { CustomerService } from "./customers/service.js";
import { PromotionService } from "./promotions/service.js";
import { CampaignService } from "./campaigns/service.js";
import { AutomationService } from "./automations/service.js";
import { AnalyticsService } from "./analytics/service.js";
import { TeamService } from "./team/service.js";
import {
  IntegrationService,
  integrationEvents,
} from "./integrations/service.js";
import { PaymentService } from "./payments/service.js";
import { WarehouseService } from "./warehouse/service.js";
import { DeliveryService } from "./delivery/service.js";
import { CustomerPortalService } from "./customers/portal-service.js";
import { registerOnboardingRoutes } from "./routes/onboarding.routes.js";
export function createApp(options = {}) {
  const store = new JsonStore(options.databaseFile || "data/v6.json");
  const auth = new AuthService(store);
  const tenancy = new TenancyService(store);
  const catalog = new CatalogService(store, tenancy);
  const media = new MediaService({
    directory: options.mediaDirectory || "uploads/v6",
  });
  const imports = new ImportService(catalog);
  const storefront = new StorefrontService(store, tenancy, catalog);
  const orders = new OrderService(store, tenancy);
  const telegram = new TelegramService(store, tenancy, orders, {
    fetch: options.fetch,
    secret: options.telegramSecret,
  });
  const telegramCustomers = new TelegramCustomerService(store, telegram, {
    secret: options.customerSessionSecret || options.telegramSecret,
    maxAge: options.telegramInitDataMaxAge,
  });
  const customers = new CustomerService(store, tenancy);
  const promotions = new PromotionService(store, tenancy);
  orders.promotions = promotions;
  const campaigns = new CampaignService(store, tenancy, customers, telegram);
  const automations = new AutomationService(store, tenancy, telegram);
  const analytics = new AnalyticsService(store, tenancy);
  const team = new TeamService(store, tenancy, auth);
  const integrations = new IntegrationService(store, tenancy, {
    fetch: options.fetch,
  });
  const payments = new PaymentService(store, tenancy, orders, {
    webhookSecret: options.paymentWebhookSecret,
  });
  const warehouse = new WarehouseService(store, tenancy);
  const delivery = new DeliveryService(store, tenancy);
  const customerPortal = new CustomerPortalService(store, telegramCustomers);
  const router = new Router();
  const secured = (handler) => async (ctx) => {
    const header = ctx.req.headers.authorization || "";
    const raw = header.startsWith("Bearer ") ? header.slice(7) : "";
    const identity = auth.authenticate(raw);
    return handler({ ...ctx, identity, token: raw });
  };
  
  registerOnboardingRoutes(
    router,
    {
      tenancy,
      telegram,
    },
    secured,
  );
  router.add("GET", "/api/v6/health", async () => ({
    status: 200,
    body: {
      ok: true,
      version: "6.20.0",
      revision: store.snapshot().revision,
      time: new Date().toISOString(),
    },
  }));
  router.add("POST", "/api/v6/bootstrap", async ({ body }) => ({
    status: 201,
    body: await auth.bootstrap(body.email, body.password, body.name),
  }));
  router.add("POST", "/api/v6/auth/login", async ({ body, req }) => ({
    status: 200,
    body: await auth.login(body.email, body.password, {
      ip: req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
    }),
  }));
  router.add(
    "POST",
    "/api/v6/auth/logout",
    secured(async ({ token }) => {
      await auth.logout(token);
      return { status: 204, body: null };
    }),
  );
  router.add(
    "GET",
    "/api/v6/me",
    secured(async ({ identity }) => {
      const memberships = identity.state.memberships.filter(
        (m) => m.userId === identity.user.id,
      );
      return {
        status: 200,
        body: {
          user: auth.publicUser(identity.user),
          memberships,
          workspaces: identity.state.workspaces.filter((w) =>
            memberships.some((m) => m.workspaceId === w.id),
          ),
        },
      };
    }),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: tenancy.shops(identity.user.id, params.workspaceId),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/team",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: {
        members: team.list(identity.user.id, params.workspaceId),
        invites: team.invites(identity.user.id, params.workspaceId),
      },
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/team/invites",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await team.invite(identity.user.id, params.workspaceId, body),
    })),
  );
  router.add("POST", "/api/v6/team/invites/accept", async ({ body }) => ({
    status: 200,
    body: await team.accept(body),
  }));
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/team/:membershipId",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await team.update(
        identity.user.id,
        params.workspaceId,
        params.membershipId,
        body,
      ),
    })),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/team/:membershipId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await team.remove(
        identity.user.id,
        params.workspaceId,
        params.membershipId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/audit",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body: team.audit(
        identity.user.id,
        params.workspaceId,
        url.searchParams.get("limit") || 100,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await tenancy.createShop(
        identity.user.id,
        params.workspaceId,
        body,
      ),
    })),
  );
  router.add("GET", "/api/v6/payments/providers", async () => ({
    status: 200,
    body: payments.providers(),
  }));
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/payments",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body: payments.list(identity.user.id, params.workspaceId, params.shopId, {
        status: url.searchParams.get("status") || "all",
      }),
    })),
  );
  router.add(
    "POST",
    "/api/v6/public/storefronts/:slug/payments",
    async ({ params, body }) => ({
      status: 201,
      body: await payments.createPublic(params.slug, body),
    }),
  );
  router.add(
    "GET",
    "/api/v6/public/payments/:paymentId",
    async ({ params }) => ({
      status: 200,
      body: payments.getPublic(params.paymentId),
    }),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/payments/:paymentId/check",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await payments.check(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.paymentId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/payments/:paymentId/refund",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await payments.refund(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.paymentId,
        body,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/payments/webhooks/:provider",
    async ({ req, params, body }) => ({
      status: 200,
      body: await payments.webhook(
        params.provider,
        body,
        String(req.headers["x-gtstore-payment-signature"] || ""),
        JSON.stringify(body),
      ),
    }),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/inventory",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body: warehouse.inventory(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        { query: url.searchParams.get("q") || "" },
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/metrics",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: warehouse.metrics(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/movements",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body: warehouse.movements(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        { type: url.searchParams.get("type") || "all" },
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/adjust",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await warehouse.adjust(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/transfer",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await warehouse.transfer(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/stocktakes",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: warehouse.stocktakes(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/stocktakes",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await warehouse.createStocktake(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add("GET", "/api/v6/delivery/providers", async () => ({
    status: 200,
    body: delivery.providerList(),
  }));
  router.add(
    "GET",
    "/api/v6/public/storefronts/:slug/delivery/methods",
    async ({ params }) => ({
      status: 200,
      body: delivery.publicMethods(params.slug),
    }),
  );
  router.add(
    "POST",
    "/api/v6/public/storefronts/:slug/delivery/quote",
    async ({ params, body }) => ({
      status: 200,
      body: delivery.quote(params.slug, body),
    }),
  );
  router.add(
    "GET",
    "/api/v6/public/shipments/:shipmentId",
    async ({ params }) => ({
      status: 200,
      body: delivery.trackingPublic(params.shipmentId),
    }),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/methods",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: delivery.methods(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/methods",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await delivery.create(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/methods/:methodId",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await delivery.update(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.methodId,
        body,
      ),
    })),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/methods/:methodId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await delivery.remove(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.methodId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/shipments",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: delivery.shipments(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/shipments",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await delivery.createShipment(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/shipments/:shipmentId",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await delivery.updateShipment(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.shipmentId,
        body,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/integrations/events",
    secured(async () => ({ status: 200, body: integrationEvents })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/integrations",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: integrations.list(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/integrations",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await integrations.create(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/integrations/:hookId",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await integrations.update(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.hookId,
        body,
      ),
    })),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/integrations/:hookId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await integrations.remove(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.hookId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/integrations/:hookId/test",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await integrations.test(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.hookId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/integrations/:hookId/rotate-secret",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await integrations.rotateSecret(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.hookId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/integrations/deliveries",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body: integrations.deliveries(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        url.searchParams.get("hookId") || "",
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/categories",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body:
        url.searchParams.get("tree") === "1"
          ? catalog.categoryTree(
              identity.user.id,
              params.workspaceId,
              params.shopId,
            )
          : catalog.categories(
              identity.user.id,
              params.workspaceId,
              params.shopId,
            ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/categories",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await catalog.createCategory(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/categories/:categoryId",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await catalog.updateCategory(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.categoryId,
        body,
      ),
    })),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/categories/:categoryId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await catalog.deleteCategory(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.categoryId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/products",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body: catalog.products(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        {
          query: url.searchParams.get("q") || "",
          categoryId: url.searchParams.get("categoryId") || "",
          status: url.searchParams.get("status") || "all",
        },
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/products/:productId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: catalog.product(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.productId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/products",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await catalog.createProduct(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/products/:productId",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await catalog.updateProduct(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.productId,
        body,
      ),
    })),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/products/:productId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await catalog.deleteProduct(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.productId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/products/bulk",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await catalog.bulkUpdate(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/import/preview",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: catalog.importPreview(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body.rows || [],
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/media",
    secured(async ({ identity, params, body }) => {
      catalog.ensureShop(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        "manager",
      );
      return { status: 201, body: await media.upload(body) };
    }),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/media/:filename",
    secured(async ({ identity, params }) => {
      catalog.ensureShop(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        "manager",
      );
      return { status: 200, body: await media.remove(params.filename) };
    }),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/import/file",
    secured(async ({ identity, params, body }) => {
      catalog.ensureShop(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        "manager",
      );
      const workbook = await imports.parseWorkbookBase64(
        body.base64,
        body.filename,
      );
      return {
        status: 200,
        body: imports.preview(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          workbook,
        ),
      };
    }),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/import/commit",
    secured(async ({ identity, params, body }) => {
      catalog.ensureShop(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        "manager",
      );
      const workbook = await imports.parseWorkbookBase64(
        body.base64,
        body.filename,
      );
      return {
        status: 201,
        body: await imports.commit(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          workbook,
          body.options || {},
        ),
      };
    }),
  );
  router.add("GET", "/api/v6/storefront/theme-presets", async () => ({
    status: 200,
    body: storefront.presets(),
  }));
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/storefront",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: storefront.draft(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/storefront",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await storefront.saveDraft(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/storefront/publish",
    secured(async ({ identity, params }) => ({
      status: 201,
      body: await storefront.publish(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/storefront/versions",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: storefront.versions(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/storefront/versions/:versionId/restore",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await storefront.restore(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.versionId,
      ),
    })),
  );
  router.add("GET", "/api/v6/public/storefronts/:slug", async ({ params }) => ({
    status: 200,
    body: storefront.publicStore(params.slug),
  }));
  router.add(
    "GET",
    "/api/v6/public/storefronts/:slug/checkout-config",
    async ({ params }) => ({
      status: 200,
      body: orders.checkoutConfig(params.slug),
    }),
  );
  router.add(
    "POST",
    "/api/v6/public/storefronts/:slug/checkout/quote",
    async ({ params, body }) => ({
      status: 200,
      body: orders.quotePublic(params.slug, body),
    }),
  );
  router.add(
    "POST",
    "/api/v6/public/storefronts/:slug/analytics/events",
    async ({ params, body }) => ({
      status: 202,
      body: await analytics.track(params.slug, body),
    }),
  );
  router.add(
    "POST",
    "/api/v6/public/storefronts/:slug/orders",
    async ({ params, body }) => {
      const order = await orders.createPublic(params.slug, body);
      const webhook = await integrations.emit(
        order.shopId,
        "order.created",
        order,
      );
      const telegramNotification = await telegram.notifyNewOrder(order);
      const automation = await automations.handleOrderEvent(order, {
        type: "order_created",
        to: "new",
      });
      return {
        status: 201,
        body: { ...order, telegramNotification, automation, webhook },
      };
    },
  );
  router.add(
    "POST",
    "/api/v6/public/storefronts/:slug/telegram/auth",
    async ({ params, body }) => ({
      status: 200,
      body: telegramCustomers.authenticate(params.slug, body.initData),
    }),
  );
  router.add("GET", "/api/v6/public/customer/me", async ({ req }) => ({
    status: 200,
    body: telegramCustomers.profile(
      String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""),
    ),
  }));
  const customerToken = (req) =>
    String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  router.add("GET", "/api/v6/public/profile", async ({ req }) => ({
    status: 200,
    body: customerPortal.profile(customerToken(req)),
  }));
  router.add("PATCH", "/api/v6/public/profile", async ({ req, body }) => ({
    status: 200,
    body: await customerPortal.update(customerToken(req), body),
  }));
  router.add("GET", "/api/v6/public/profile/orders", async ({ req }) => ({
    status: 200,
    body: customerPortal.orders(customerToken(req)),
  }));
  router.add("GET", "/api/v6/public/profile/bonuses", async ({ req }) => ({
    status: 200,
    body: customerPortal.bonuses(customerToken(req)),
  }));
  router.add(
    "GET",
    "/api/v6/public/profile/notifications",
    async ({ req }) => ({
      status: 200,
      body: customerPortal.notifications(customerToken(req)),
    }),
  );
  router.add("GET", "/api/v6/public/profile/wishlist", async ({ req }) => ({
    status: 200,
    body: customerPortal.wishlist(customerToken(req)),
  }));
  router.add(
    "POST",
    "/api/v6/public/profile/wishlist",
    async ({ req, body }) => ({
      status: 201,
      body: await customerPortal.addWishlist(
        customerToken(req),
        body.productId,
      ),
    }),
  );
  router.add(
    "DELETE",
    "/api/v6/public/profile/wishlist/:productId",
    async ({ req, params }) => ({
      status: 200,
      body: await customerPortal.removeWishlist(
        customerToken(req),
        params.productId,
      ),
    }),
  );
  router.add("GET", "/api/v6/public/profile/addresses", async ({ req }) => ({
    status: 200,
    body: customerPortal.addresses(customerToken(req)),
  }));
  router.add(
    "POST",
    "/api/v6/public/profile/addresses",
    async ({ req, body }) => ({
      status: 201,
      body: await customerPortal.addAddress(customerToken(req), body),
    }),
  );
  router.add(
    "PATCH",
    "/api/v6/public/profile/addresses/:addressId",
    async ({ req, params, body }) => ({
      status: 200,
      body: await customerPortal.updateAddress(
        customerToken(req),
        params.addressId,
        body,
      ),
    }),
  );
  router.add(
    "DELETE",
    "/api/v6/public/profile/addresses/:addressId",
    async ({ req, params }) => ({
      status: 200,
      body: await customerPortal.removeAddress(
        customerToken(req),
        params.addressId,
      ),
    }),
  );
  router.add(
    "POST",
    "/api/v6/public/profile/repeat-order/:orderId",
    async ({ req, params }) => ({
      status: 200,
      body: customerPortal.repeatOrder(customerToken(req), params.orderId),
    }),
  );

  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/promotions",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: promotions.list(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/promotions",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await promotions.create(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/promotions/:promoId",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await promotions.update(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.promoId,
        body,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/customers",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body: customers.list(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        {
          query: url.searchParams.get("q") || "",
          segment: url.searchParams.get("segment") || "all",
        },
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/customers/metrics",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: customers.metrics(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/customers/:customerKey",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: customers.get(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        decodeURIComponent(params.customerKey),
      ),
    })),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/customers/:customerKey",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await customers.update(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        decodeURIComponent(params.customerKey),
        body,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/customers/:customerKey/bonus",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await customers.adjustBonus(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        decodeURIComponent(params.customerKey),
        body,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/customers/:customerKey/promos",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await customers.createPersonalPromo(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        decodeURIComponent(params.customerKey),
        body,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/campaigns",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: campaigns.list(identity.user.id, params.workspaceId, params.shopId),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/campaigns",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await campaigns.create(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/campaigns/:campaignId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: campaigns.get(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.campaignId,
      ),
    })),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/campaigns/:campaignId",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await campaigns.update(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.campaignId,
        body,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/campaigns/:campaignId/send",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await campaigns.send(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.campaignId,
      ),
    })),
  );
  router.add("POST", "/api/v6/internal/campaigns/run-due", async ({ req }) => {
    const secret = String(req.headers["x-gtstore-scheduler-secret"] || "");
    if (
      process.env.GTSTORE_SCHEDULER_SECRET &&
      secret !== process.env.GTSTORE_SCHEDULER_SECRET
    )
      return {
        status: 403,
        body: {
          error: {
            code: "SCHEDULER_FORBIDDEN",
            message: "Неверный секрет планировщика",
          },
        },
      };
    return { status: 200, body: await campaigns.runDue() };
  });
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/automations",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: automations.list(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/automations",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await automations.create(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/automations/:ruleId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: automations.get(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.ruleId,
      ),
    })),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/automations/:ruleId",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await automations.update(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.ruleId,
        body,
      ),
    })),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/automations/:ruleId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await automations.remove(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.ruleId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/internal/automations/run-due",
    async ({ req }) => {
      const secret = String(req.headers["x-gtstore-scheduler-secret"] || "");
      if (
        process.env.GTSTORE_SCHEDULER_SECRET &&
        secret !== process.env.GTSTORE_SCHEDULER_SECRET
      )
        return {
          status: 403,
          body: {
            error: {
              code: "SCHEDULER_FORBIDDEN",
              message: "Неверный секрет планировщика",
            },
          },
        };
      return { status: 200, body: await automations.runDue() };
    },
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/telegram",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: telegram.getConfig(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/telegram/connect",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await telegram.connect(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/telegram/test",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await telegram.test(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/telegram",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await telegram.disconnect(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/telegram/webhook/:shopId",
    async ({ req, params, body }) => ({
      status: 200,
      body: await telegram.webhook(
        params.shopId,
        body,
        String(req.headers["x-telegram-bot-api-secret-token"] || ""),
      ),
    }),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/analytics",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body: analytics.dashboard(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        url.searchParams.get("days") || 30,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/orders",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body: orders.list(identity.user.id, params.workspaceId, params.shopId, {
        query: url.searchParams.get("q") || "",
        status: url.searchParams.get("status") || "all",
      }),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/orders/metrics",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: orders.metrics(identity.user.id, params.workspaceId, params.shopId),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/orders/:orderId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: orders.get(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.orderId,
      ),
    })),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/orders/:orderId",
    secured(async ({ identity, params, body }) => {
      const order = await orders.update(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.orderId,
        body,
      );
      const webhook = await integrations.emit(
        order.shopId,
        body.status ? "order.status_changed" : "order.updated",
        order,
      );
      const customerNotification = body.status
        ? await telegram.notifyCustomer(order)
        : { sent: false, reason: "status_unchanged" };
      const loyaltyEntry =
        body.status === "completed"
          ? await customers.accrueForOrder(order)
          : null;
      const automation = body.status
        ? await automations.handleOrderEvent(order, {
            type: "order_status_changed",
            to: body.status,
          })
        : { queued: 0 };
      return {
        status: 200,
        body: {
          ...order,
          customerNotification,
          loyaltyEntry,
          automation,
          webhook,
        },
      };
    }),
  );
  const server = http.createServer(async (req, res) => {
    const requestId = id("req");
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname.startsWith("/api/v6/media/")) {
        const filename = decodeURIComponent(
          url.pathname.slice("/api/v6/media/".length),
        );
        const file = media.resolve(filename);
        const type =
          {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
            ".gif": "image/gif",
          }[path.extname(file).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, {
          "content-type": type,
          "cache-control": "public, max-age=31536000, immutable",
          "access-control-allow-origin": "*",
        });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
        });
        return res.end();
      }
      const route = router.match(req.method, url.pathname);
      const body = ["POST", "PATCH", "PUT"].includes(req.method)
        ? await readJson(req)
        : {};
      const result = await route.handler({
        req,
        res,
        url,
        body,
        params: route.params,
        requestId,
      });
      if (result.status === 204) {
        res.writeHead(204);
        return res.end();
      }
      json(res, result.status || 200, result.body, {
        "x-request-id": requestId,
        "access-control-allow-origin": "*",
      });
    } catch (error) {
      json(res, error.status || 500, errorPayload(error, requestId), {
        "x-request-id": requestId,
        "access-control-allow-origin": "*",
      });
    }
  });
  return {
    server,
    services: {
      store,
      auth,
      tenancy,
      catalog,
      media,
      imports,
      storefront,
      orders,
      telegram,
      telegramCustomers,
      customers,
      promotions,
      campaigns,
      automations,
      analytics,
      team,
      integrations,
      payments,
      warehouse,
      delivery,
      customerPortal,
    },
  };
}
