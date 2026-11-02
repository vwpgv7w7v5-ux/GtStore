import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { JsonStore } from "./core/store.js";
import { AuthService } from "./auth/service.js";
import { TenancyService } from "./tenancy/service.js";
import { CatalogService } from "./catalog/service.js";
import { Router, json, readJson } from "./http/router.js";
import { AppError, errorPayload } from "./core/errors.js";
import { id } from "./core/ids.js";
import { MediaService } from "./media/service.js";
import { ImportService } from "./imports/service.js";
import { ImportJobs } from "./imports/jobs.js";
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
import { MailService } from "./mail/service.js";
import { ApiKeyService } from "./apikeys/service.js";
import { ReferralService } from "./referrals/service.js";
import { MaxService } from "./max/service.js";
import { FeedService } from "./feeds/service.js";
import { ChatService } from "./chats/service.js";
import { ErpService } from "./integrations/erp.js";
import { SupportService } from "./support/service.js";
import { registerOnboardingRoutes } from "./routes/onboarding.routes.js";
import { Permission } from "./team/permissions.js";
export function createApp(options = {}) {
  const store = new JsonStore(options.databaseFile || "data/v6.json");
  const auth = new AuthService(store);
  const tenancy = new TenancyService(store);
  const media = new MediaService({
    directory: options.mediaDirectory || process.env.V6_MEDIA_DIRECTORY || "uploads/v6",
    ...options.mediaOptions,
  });
  const catalog = new CatalogService(store, tenancy, media);
  const imports = new ImportService(catalog);
  const importJobs = new ImportJobs(imports, {
    directory: path.join(path.dirname(options.databaseFile || 'data/v6.json'), 'import-jobs'),
  });
  const storefront = new StorefrontService(store, tenancy, catalog, media);
  const orders = new OrderService(store, tenancy);
  const telegram = new TelegramService(store, tenancy, orders, {
    fetch: options.fetch,
    secret: options.telegramSecret,
    publicBaseUrl: options.publicBaseUrl,
    storefrontUrl: options.storefrontUrl,
    enableTelegramPolling: options.enableTelegramPolling,
  });
  const telegramCustomers = new TelegramCustomerService(store, telegram, {
    secret: options.customerSessionSecret || options.telegramSecret,
    maxAge: options.telegramInitDataMaxAge,
    downloadAvatar: options.telegramAvatarDownloader,
    media,
  });
  const customers = new CustomerService(store, tenancy);
  const promotions = new PromotionService(store, tenancy);
  const campaigns = new CampaignService(store, tenancy, customers, telegram);
  const automations = new AutomationService(store, tenancy, telegram);
  const analytics = new AnalyticsService(store, tenancy);
  const mail = new MailService({ store, ...options.mail });
  const team = new TeamService(store, tenancy, auth, mail, {
    acceptBaseUrl: options.adminUrl || process.env.ADMIN_URL,
  });
  const apiKeys = new ApiKeyService(store, tenancy);
  const referrals = new ReferralService(store, tenancy, telegram);
  const integrations = new IntegrationService(store, tenancy, {
    fetch: options.fetch,
  });
  const payments = new PaymentService(store, tenancy, orders, {
    webhookSecret: options.paymentWebhookSecret,
    fetch: options.fetch,
    yookassaShopId: options.yookassaShopId,
    yookassaSecretKey: options.yookassaSecretKey,
    publicBaseUrl: options.publicBaseUrl,
    returnUrl: options.paymentReturnUrl,
  });
  const warehouse = new WarehouseService(store, tenancy);
  const delivery = new DeliveryService(store, tenancy, { fetch: options.fetch });
  const max = new MaxService(store, tenancy, { fetch: options.fetch });
  const feeds = new FeedService(store, tenancy, catalog, imports, {
    fetch: options.fetch,
  });
  const chats = new ChatService(store, tenancy, telegram, max);
  const erp = new ErpService(store, tenancy, { fetch: options.fetch });
  const support = new SupportService(store, tenancy);
  orders.promotions = promotions;
  orders.delivery = delivery;
  orders.payments = payments;
  orders.referrals = referrals;
  const customerPortal = new CustomerPortalService(store, telegramCustomers);
  const router = new Router();
  const secured = (handler) => async (ctx) => {
    const header = ctx.req.headers.authorization || "";
    const raw = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (raw.startsWith("gtk_")) {
      const key = await apiKeys.authenticate(raw);
      if (!key) {
        throw new AppError("API_KEY_INVALID", "Недействительный API ключ", 401);
      }
      if (ctx.params?.shopId && key.shopId !== ctx.params.shopId) {
        throw new AppError(
          "API_KEY_SHOP_MISMATCH",
          "Ключ не принадлежит этому магазину",
          403,
        );
      }
      if (
        ctx.params?.workspaceId &&
        key.workspaceId !== ctx.params.workspaceId
      ) {
        throw new AppError(
          "API_KEY_WORKSPACE_MISMATCH",
          "Ключ не принадлежит этому пространству",
          403,
        );
      }
      const state = store.snapshot();
      const user =
        state.users.find((item) => item.id === key.createdBy) || {
          id: key.createdBy || `apikey:${key.id}`,
          email: `key:${key.prefix}`,
          name: key.name || "API Key",
        };
      return handler({
        ...ctx,
        identity: { user, session: null, state, apiKey: key },
        token: raw,
        apiKey: key,
      });
    }
    const identity = auth.authenticate(raw);
    return handler({ ...ctx, identity, token: raw });
  };
  const requirePermission = (identity, workspaceId, permission) => {
    if (identity.apiKey) return;
    if (!team.can(identity.user.id, workspaceId, permission)) {
      throw new AppError(
        "PERMISSION_DENIED",
        "Недостаточно прав для этого действия",
        403,
      );
    }
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
      backgroundImport: true,
      commit: options.deploymentCommit || process.env.GTSTORE_DEPLOY_COMMIT || null,
      revision: store.snapshot().revision,
      time: new Date().toISOString(),
    },
  }));
  router.add("POST", "/api/v6/bootstrap", async ({ body }) => ({
    status: 201,
    body: await auth.bootstrap(body.email, body.password, body.name),
  }));
  router.add("POST", "/api/v6/auth/register", async ({ body, req }) => ({
    status: 201,
    body: await auth.register(body.email, body.password, body.name, {
      workspaceName: body.workspaceName,
      shopName: body.shopName,
      shopSlug: body.shopSlug,
      ip: req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
    }),
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
    "/api/v6/auth/refresh",
    secured(async ({ token }) => ({
      status: 200,
      body: await auth.refresh(token),
    })),
  );
  router.add(
    "POST",
    "/api/v6/auth/logout",
    secured(async ({ token }) => {
      await auth.logout(token);
      return { status: 204, body: null };
    }),
  );
  router.add(
    "POST",
    "/api/v6/workspaces",
    secured(async ({ identity, body }) => ({
      status: 201,
      body: await tenancy.createWorkspace(identity.user.id, body),
    })),
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
        permissions: team.permissionCatalog(),
      },
    })),
  );
  router.add("GET", "/api/v6/team/permissions", secured(async () => ({
    status: 200,
    body: team.permissionCatalog(),
  })));
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
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId",
    secured(async ({ identity, params, body }) => {
      const next = { ...(body || {}) };
      if (next.logoUrl !== undefined) next.logoUrl = await media.ingestUrl(next.logoUrl);
      if (next.faviconUrl !== undefined) next.faviconUrl = await media.ingestUrl(next.faviconUrl);
      return {
        status: 200,
        body: await tenancy.updateShop(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          next,
        ),
      };
    }),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId",
    secured(async ({ identity, params }) => {
      // Stop bot polling / in-memory caches for this shop before DB purge.
      try { telegram.stopPolling?.(params.shopId); } catch {}
      try {
        if (telegram.seenMessages) {
          for (const key of [...telegram.seenMessages.keys()]) {
            if (String(key).startsWith(`${params.shopId}:`)) telegram.seenMessages.delete(key);
          }
        }
      } catch {}
      const body = await tenancy.deleteShop(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      );
      return { status: 200, body };
    }),
  );
  router.add("GET", "/api/v6/payments/providers", async () => ({
    status: 200,
    body: payments.providers(),
  }));
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/payments/providers",
    secured(async ({ identity, params }) => {
      const shop = tenancy
        .shops(identity.user.id, params.workspaceId)
        .find((item) => item.id === params.shopId);
      return { status: 200, body: payments.providers(shop) };
    }),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/payments/settings",
    secured(async ({ identity, params }) => {
      requirePermission(identity, params.workspaceId, Permission.PaymentsRead);
      tenancy.context(identity.user.id, params.workspaceId, "admin");
      const shop = store
        .snapshot()
        .shops.find((item) => item.id === params.shopId);
      const pack = (code) => {
        const cfg = shop?.settings?.payments?.[code] || {};
        const creds = payments.providerCredentials(shop, code);
        return {
          shopId: cfg.shopId || cfg.terminalKey || "",
          terminalKey: cfg.terminalKey || cfg.shopId || "",
          secretKeySet: Boolean(cfg.secretKey || cfg.token),
          secretKeyPreview: cfg.secretKey || cfg.token
            ? `${String(cfg.secretKey || cfg.token).slice(0, 4)}••••`
            : "",
          live: Boolean(creds),
          source: creds?.source || null,
        };
      };
      return {
        status: 200,
        body: {
          yookassa: pack("yookassa"),
          tbank: pack("tbank"),
          tochka: pack("tochka"),
          yapay: pack("yapay"),
          split: pack("split"),
          checkoutMethods: {
            cash: true,
            transfer: true,
            yookassa: true,
            tbank: true,
            tochka: true,
            yapay: true,
            split: true,
            ...(shop?.settings?.payments?.checkoutMethods || {}),
          },
          fiscal: payments.fiscalSettings(shop),
          legal: payments.legalEntity(shop),
          providers: payments.providers(shop),
        },
      };
    }),
  );
  router.add(
    "PUT",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/payments/settings",
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.PaymentsWrite);
      const current = store
        .snapshot()
        .shops.find((item) => item.id === params.shopId);
      const mergeProvider = (code, input = {}) => {
        const prev = current?.settings?.payments?.[code] || {};
        const next = {
          shopId: String(input.shopId || input.terminalKey || prev.shopId || "").trim(),
          terminalKey: String(
            input.terminalKey || input.shopId || prev.terminalKey || "",
          ).trim(),
          secretKey: String(input.secretKey || input.token || "").trim(),
          token: String(input.token || input.secretKey || "").trim(),
        };
        if (!next.secretKey) next.secretKey = prev.secretKey || prev.token || "";
        if (!next.token) next.token = prev.token || prev.secretKey || "";
        if (input.clearSecret) {
          next.secretKey = "";
          next.token = "";
        }
        return next;
      };
      const paymentsSettings = { ...(current?.settings?.payments || {}) };
      for (const code of ["yookassa", "tbank", "tochka", "yapay", "split"]) {
        if (body?.[code]) paymentsSettings[code] = mergeProvider(code, body[code]);
      }
      if (body?.fiscal) {
        paymentsSettings.fiscal = {
          ...(paymentsSettings.fiscal || {}),
          ...body.fiscal,
        };
      }
      if (body?.checkoutMethods && typeof body.checkoutMethods === "object") {
        const prev = paymentsSettings.checkoutMethods || {};
        const next = { ...prev };
        for (const [key, value] of Object.entries(body.checkoutMethods)) {
          if (
            [
              "cash",
              "transfer",
              "yookassa",
              "tbank",
              "tochka",
              "yapay",
              "split",
              "manual",
            ].includes(key)
          ) {
            next[key] = value !== false && value !== "false" && value !== 0;
          }
        }
        paymentsSettings.checkoutMethods = next;
      }
      const settings = { payments: paymentsSettings };
      if (body?.legal) settings.legal = body.legal;
      const shop = await tenancy.updateShop(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        { settings },
      );
      return {
        status: 200,
        body: {
          yookassa: {
            shopId: shop.settings?.payments?.yookassa?.shopId || "",
            secretKeySet: Boolean(shop.settings?.payments?.yookassa?.secretKey),
            live: payments.yookassaConfigured(shop),
            source: payments.yookassaCredentials(shop)?.source || null,
          },
          tbank: payments.providerCredentials(shop, "tbank")
            ? { live: true, source: "shop" }
            : { live: false },
          tochka: payments.providerCredentials(shop, "tochka")
            ? { live: true, source: "shop" }
            : { live: false },
          yapay: payments.providerCredentials(shop, "yapay")
            ? { live: true, source: "shop" }
            : { live: false },
          split: payments.providerCredentials(shop, "split")
            ? { live: true, source: "shop" }
            : { live: false },
          checkoutMethods: {
            cash: true,
            transfer: true,
            yookassa: true,
            tbank: true,
            tochka: true,
            yapay: true,
            split: true,
            ...(shop.settings?.payments?.checkoutMethods || {}),
          },
          fiscal: payments.fiscalSettings(shop),
          legal: payments.legalEntity(shop),
          providers: payments.providers(shop),
        },
      };
    }),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/payments/receipts",
    secured(async ({ identity, params }) => {
      requirePermission(identity, params.workspaceId, Permission.PaymentsRead);
      return {
        status: 200,
        body: payments.receipts(
          identity.user.id,
          params.workspaceId,
          params.shopId,
        ),
      };
    }),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/payments",
    secured(async ({ identity, params, url }) => {
      requirePermission(identity, params.workspaceId, Permission.PaymentsRead);
      return {
        status: 200,
        body: payments.list(identity.user.id, params.workspaceId, params.shopId, {
          status: url.searchParams.get("status") || "all",
        }),
      };
    }),
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
    secured(async ({ identity, params }) => {
      requirePermission(identity, params.workspaceId, Permission.PaymentsWrite);
      return {
        status: 200,
        body: await payments.check(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          params.paymentId,
        ),
      };
    }),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/payments/:paymentId/refund",
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.PaymentsWrite);
      return {
        status: 200,
        body: await payments.refund(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          params.paymentId,
          body,
        ),
      };
    }),
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
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/reservations",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: warehouse.reservations(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/reservations/:reservationId/release",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await warehouse.releaseReservation(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.reservationId,
      ),
    })),
  );
  router.add("GET", "/api/v6/delivery/providers", async () => ({
    status: 200,
    body: delivery.providerList(),
  }));
  router.add("GET", "/api/v6/delivery/carriers", async () => ({
    status: 200,
    body: delivery.carriers(),
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
      body: await delivery.quote(params.slug, body),
    }),
  );
  router.add(
    "GET",
    "/api/v6/public/storefronts/:slug/delivery/points",
    async ({ params, url }) => ({
      status: 200,
      body: await delivery.pickupPoints(params.slug, {
        city: url.searchParams.get("city") || "Москва",
        carrier: url.searchParams.get("carrier") || "apiship",
        q: url.searchParams.get("q") || "",
      }),
    }),
  );
  router.add(
    "GET",
    "/api/v6/public/storefronts/:slug/delivery/zones",
    async ({ params }) => ({
      status: 200,
      body: delivery.publicZones(params.slug),
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
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.DeliveryWrite);
      return {
        status: 201,
        body: await delivery.create(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          body,
        ),
      };
    }),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/methods/:methodId",
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.DeliveryWrite);
      return {
        status: 200,
        body: await delivery.update(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          params.methodId,
          body,
        ),
      };
    }),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/methods/:methodId",
    secured(async ({ identity, params }) => {
      requirePermission(identity, params.workspaceId, Permission.DeliveryWrite);
      return {
        status: 200,
        body: await delivery.remove(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          params.methodId,
        ),
      };
    }),
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
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.DeliveryWrite);
      return {
        status: 201,
        body: await delivery.createShipment(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          body,
        ),
      };
    }),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/shipments/:shipmentId",
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.DeliveryWrite);
      return {
        status: 200,
        body: await delivery.updateShipment(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          params.shipmentId,
          body,
        ),
      };
    }),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/apiship",
    secured(async ({ identity, params }) => {
      const shop = store
        .snapshot()
        .shops.find((item) => item.id === params.shopId);
      delivery.ensure(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        "viewer",
      );
      return { status: 200, body: delivery.apishipSettings(shop) };
    }),
  );
  router.add(
    "PUT",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/apiship",
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.DeliveryWrite);
      return {
        status: 200,
        body: await delivery.saveApiship(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          body || {},
        ),
      };
    }),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/zones",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: delivery.zones(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/zones",
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.DeliveryWrite);
      return {
        status: 201,
        body: await delivery.createZone(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          body,
        ),
      };
    }),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/zones/:zoneId",
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.DeliveryWrite);
      return {
        status: 200,
        body: await delivery.updateZone(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          params.zoneId,
          body,
        ),
      };
    }),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/delivery/zones/:zoneId",
    secured(async ({ identity, params }) => {
      requirePermission(identity, params.workspaceId, Permission.DeliveryWrite);
      return {
        status: 200,
        body: await delivery.removeZone(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          params.zoneId,
        ),
      };
    }),
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
    "/api/v6/workspaces/:workspaceId/shops/:shopId/api-keys",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: apiKeys.list(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/api-keys",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await apiKeys.create(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/api-keys/:keyId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await apiKeys.revoke(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.keyId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/referrals",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: referrals.list(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/referrals/program",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: referrals.getProgram(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "PUT",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/referrals/program",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await referrals.updateProgram(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/referrals",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await referrals.create(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/public/storefronts/:slug/referrals/validate",
    async ({ params, url }) => ({
      status: 200,
      body: referrals.validatePublic(
        params.slug,
        url.searchParams.get("code") || "",
      ),
    }),
  );
  router.add("GET", "/api/v6/public/profile/referral", async ({ req }) => {
    const token =
      req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
      req.headers["x-customer-token"] ||
      "";
    const session = telegramCustomers.verifySession(token);
    const state = store.snapshot();
    const shop = state.shops.find((item) => item.id === session.shopId);
    if (!shop) {
      throw new AppError("SHOP_NOT_FOUND", "Магазин не найден", 404);
    }
    const profile = (state.customerProfiles || []).find(
      (item) =>
        item.shopId === shop.id && item.key === `tg:${session.telegramId}`,
    );
    const name =
      profile?.name ||
      [session.firstName, session.lastName].filter(Boolean).join(" ") ||
      session.username ||
      "";
    return {
      status: 200,
      body: await referrals.customerInvite({
        shop,
        session,
        name,
      }),
    };
  });
  // Explicit mint — same as GET, kept for clients that POST after consent
  router.add("POST", "/api/v6/public/profile/referral", async ({ req }) => {
    const token =
      req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
      req.headers["x-customer-token"] ||
      "";
    const session = telegramCustomers.verifySession(token);
    const state = store.snapshot();
    const shop = state.shops.find((item) => item.id === session.shopId);
    if (!shop) {
      throw new AppError("SHOP_NOT_FOUND", "Магазин не найден", 404);
    }
    const profile = (state.customerProfiles || []).find(
      (item) =>
        item.shopId === shop.id && item.key === `tg:${session.telegramId}`,
    );
    return {
      status: 200,
      body: await referrals.customerInvite({
        shop,
        session,
        name: profile?.name || session.username || "",
      }),
    };
  });
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
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.CatalogWrite);
      return {
        status: 201,
        body: await catalog.createCategory(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          body,
        ),
      };
    }),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/categories/:categoryId",
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.CatalogWrite);
      return {
        status: 200,
        body: await catalog.updateCategory(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          params.categoryId,
          body,
        ),
      };
    }),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/categories/:categoryId",
    secured(async ({ identity, params, url }) => {
      requirePermission(identity, params.workspaceId, Permission.CatalogWrite);
      const cascade =
        url.searchParams.get("cascade") === "1" ||
        url.searchParams.get("cascade") === "true";
      return {
        status: 200,
        body: await catalog.deleteCategory(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          params.categoryId,
          { cascade },
        ),
      };
    }),
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
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.CatalogWrite);
      return {
        status: 201,
        body: await catalog.createProduct(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          body,
        ),
      };
    }),
  );
  router.add(
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/products/:productId",
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.CatalogWrite);
      return {
        status: 200,
        body: await catalog.updateProduct(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          params.productId,
          body,
        ),
      };
    }),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/products/:productId",
    secured(async ({ identity, params }) => {
      requirePermission(identity, params.workspaceId, Permission.CatalogWrite);
      return {
        status: 200,
        body: await catalog.deleteProduct(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          params.productId,
        ),
      };
    }),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/products/bulk",
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.CatalogWrite);
      return {
        status: 200,
        body: await catalog.bulkUpdate(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          body,
        ),
      };
    }),
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
      const referenced = value => {
        if (typeof value === 'string') {
          try { return new URL(value, 'https://local.invalid').pathname === `${media.publicPrefix}${params.filename}`; }
          catch { return false; }
        }
        if (!value || typeof value !== 'object') return false;
        return Object.values(value).some(referenced);
      };
      const snapshot = store.snapshot();
      const inUse = ['products', 'categories', 'shops', 'storefronts'].some(collection => referenced(snapshot[collection]));
      if (inUse) throw new AppError('MEDIA_IN_USE', 'Фотография используется товарами', 409);
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
      requirePermission(identity, params.workspaceId, Permission.CatalogWrite);
      if (importJobs.active.has(`${params.workspaceId}:${params.shopId}`)) {
        throw new AppError('IMPORT_BUSY', 'В этом магазине уже выполняется фоновый импорт', 409);
      }
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
  router.add('POST', '/api/v6/workspaces/:workspaceId/shops/:shopId/import/jobs', secured(async ({ identity, params, body }) => {
    requirePermission(identity, params.workspaceId, Permission.CatalogWrite);
    catalog.ensureShop(identity.user.id, params.workspaceId, params.shopId, 'manager');
    const workbook = await imports.parseWorkbookBase64(body.base64, body.filename);
    return { status: 202, body: importJobs.start(identity.user.id, params.workspaceId, params.shopId, workbook, body.options) };
  }));
  router.add('GET', '/api/v6/workspaces/:workspaceId/shops/:shopId/import/jobs/:jobId', secured(async ({ identity, params }) => {
    requirePermission(identity, params.workspaceId, Permission.CatalogWrite);
    catalog.ensureShop(identity.user.id, params.workspaceId, params.shopId, 'manager');
    return { status: 200, body: importJobs.get(identity.user.id, params.workspaceId, params.shopId, params.jobId) };
  }));
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/import/template.xlsx",
    secured(async ({ identity, params }) => {
      catalog.ensureShop(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        "manager",
      );
      return { status: 200, body: await imports.buildTemplateWorkbook() };
    }),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/export/xlsx",
    secured(async ({ identity, params }) => {
      catalog.ensureShop(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        "manager",
      );
      return {
        status: 200,
        body: await imports.exportCatalog(
          identity.user.id,
          params.workspaceId,
          params.shopId,
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
    secured(async ({ identity, params, body }) => {
      requirePermission(identity, params.workspaceId, Permission.StorefrontWrite);
      return {
        status: 200,
        body: await storefront.saveDraft(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          body,
        ),
      };
    }),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/storefront/publish",
    secured(async ({ identity, params }) => {
      requirePermission(identity, params.workspaceId, Permission.StorefrontWrite);
      return {
        status: 201,
        body: await storefront.publish(
          identity.user.id,
          params.workspaceId,
          params.shopId,
        ),
      };
    }),
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
    secured(async ({ identity, params }) => {
      requirePermission(identity, params.workspaceId, Permission.StorefrontWrite);
      return {
        status: 200,
        body: await storefront.restore(
          identity.user.id,
          params.workspaceId,
          params.shopId,
          params.versionId,
        ),
      };
    }),
  );
  router.add("GET", "/api/v6/public/config", async () => ({
    status: 200,
    body: {
      yandexMapsApiKey:
        options.yandexMapsApiKey ||
        process.env.YANDEX_MAPS_API_KEY ||
        "",
    },
    headers: {
      "cache-control": "no-store",
    },
  }));
  router.add("GET", "/api/v6/public/storefronts/:slug", async ({ params }) => ({
    status: 200,
    body: storefront.publicStore(params.slug),
    headers: {
      "cache-control": "no-store, no-cache, must-revalidate",
      pragma: "no-cache",
    },
  }));
  router.add(
    "GET",
    "/api/v6/public/storefronts/:slug/checkout-config",
    async ({ params }) => ({
      status: 200,
      body: orders.checkoutConfig(params.slug),
      headers: {
        "cache-control": "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
      },
    }),
  );
  router.add(
    "POST",
    "/api/v6/public/storefronts/:slug/checkout/quote",
    async ({ params, body }) => ({
      status: 200,
      body: await orders.quotePublic(params.slug, body),
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
      const created = await orders.createPublic(params.slug, body);
      let payment = null;
      if (orders.isOnlinePayment(created.paymentMethod)) {
        payment = await payments.createPublic(params.slug, {
          orderId: created.id,
          provider: created.paymentMethod,
          returnUrl: body.returnUrl,
        });
      }
      const order =
        store.snapshot().orders.find((item) => item.id === created.id) ||
        created;
      if (order.referralCode || body.referralCode) {
        await referrals.registerOrder(
          order.shopId,
          order.referralCode || body.referralCode,
          order.id,
          Number(order.subtotal || order.total || 0),
          order.customer?.telegramId || body.customer?.telegramId || "",
        );
      }
      const webhook = await integrations.emit(
        order.shopId,
        "order.created",
        order,
      );
      const telegramNotification = await telegram.notifyNewOrder(order);
      const automation = await automations.handleOrderEvent(order, {
        type: "order_created",
        to: order.status || "new",
      });
      return {
        status: 201,
        body: {
          ...order,
          payment,
          checkoutUrl: payment?.checkoutUrl || null,
          telegramNotification,
          automation,
          webhook,
        },
      };
    },
  );
  router.add(
    "POST",
    "/api/v6/public/telegram/resolve-shop",
    async ({ body }) => {
      const resolved = telegramCustomers.resolveShopByInitData(body?.initData);
      if (!resolved) {
        throw new AppError(
          "SHOP_NOT_RESOLVED",
          "Не удалось определить магазин бота",
          404,
        );
      }
      return { status: 200, body: resolved };
    },
  );
  router.add(
    "POST",
    "/api/v6/public/storefronts/:slug/telegram/auth",
    async ({ params, body }) => {
      const auth = await telegramCustomers.authenticate(
        params.slug,
        body.initData,
      );
      // Auto-mint personal referral code on every Mini App auth (industry standard)
      let referral = null;
      try {
        const state = store.snapshot();
        const shop = state.shops.find((item) => item.id === auth.shop?.id);
        if (shop) {
          referral = await referrals.customerInvite({
            shop,
            session: {
              telegramId: auth.customer?.telegramId,
              username: auth.customer?.username,
              firstName: auth.customer?.firstName,
              lastName: auth.customer?.lastName,
            },
            name: [auth.customer?.firstName, auth.customer?.lastName]
              .filter(Boolean)
              .join(" "),
          });
        }
      } catch {
        referral = null;
      }
      return {
        status: 200,
        body: { ...auth, referral },
      };
    },
  );
  router.add(
    "GET",
    "/api/v6/public/storefronts/:slug/telegram/avatar",
    async ({ params, url, req }) => {
      const token = String(
        url.searchParams.get("t") ||
          url.searchParams.get("token") ||
          String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""),
      );
      const saved = await telegramCustomers.ensureAvatar(params.slug, token);
      return {
        status: 302,
        redirect: saved.url,
      };
    },
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
    "/api/v6/workspaces/:workspaceId/shops/:shopId/customers/broadcast/audience",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body: campaigns.audiencePreview(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        url.searchParams.get("segment") || "telegram",
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/customers/broadcast",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await campaigns.broadcast(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
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
  router.add("POST", "/api/v6/internal/imports/run-due", async ({ req }) => {
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
    return { status: 200, body: await feeds.runDue() };
  });
  // MAX channel
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/max",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: max.status(identity.user.id, params.workspaceId, params.shopId),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/max/connect",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await max.connect(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/max",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await max.disconnect(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/public/max/:shopId/webhook",
    async ({ params, body }) => ({
      status: 200,
      body: await max.webhook(params.shopId, body),
    }),
  );
  // Feeds + scheduled import
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/feeds",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: feeds.list(identity.user.id, params.workspaceId, params.shopId),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/feeds",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await feeds.create(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/feeds/:feedId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await feeds.remove(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.feedId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/public/storefronts/:slug/feed.yml",
    async ({ params }) => {
      const feed = feeds.exportYml(params.slug);
      return {
        status: 200,
        raw: feed.body,
        contentType: feed.contentType,
      };
    },
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/import-jobs",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: feeds.importJobs(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/import-jobs",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await feeds.scheduleImport(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/import-jobs/:jobId/run",
    secured(async ({ identity, params }) => {
      const jobs = feeds.importJobs(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      );
      const job = jobs.find((j) => j.id === params.jobId);
      if (!job) {
        throw new AppError("IMPORT_JOB_NOT_FOUND", "Задача импорта не найдена", 404);
      }
      return { status: 200, body: await feeds.runImportJob(job) };
    }),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/import-jobs/:jobId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await feeds.removeImportJob(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.jobId,
      ),
    })),
  );
  // Chats + channel posts
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/chats",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: chats.threads(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/chats/:channel/:externalUserId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: chats.thread(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.channel,
        decodeURIComponent(params.externalUserId),
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/chats/reply",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await chats.reply(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/channel-posts",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: chats.posts(identity.user.id, params.workspaceId, params.shopId),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/channel-posts",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await chats.postChannel(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  // Help / knowledge base + platform support chat
  router.add("GET", "/api/v6/help/sections", async () => ({
    status: 200,
    body: support.sections(),
  }));
  router.add("GET", "/api/v6/help/articles", async ({ url }) => ({
    status: 200,
    body: support.search(
      url.searchParams.get("q") || "",
      url.searchParams.get("section") || "",
    ),
  }));
  router.add("GET", "/api/v6/help/articles/:articleId", async ({ params }) => ({
    status: 200,
    body: support.getArticle(params.articleId),
  }));
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/support/thread",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: support.thread(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/support/tickets",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: support.tickets(
        identity.user.id,
        params.workspaceId,
        params.shopId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/support/messages",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await support.sendMessage(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  // ERP: MoySklad / 1C / YClients
  router.add("GET", "/api/v6/erp/providers", async () => ({
    status: 200,
    body: erp.providers(),
  }));
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/erp",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: erp.list(identity.user.id, params.workspaceId, params.shopId),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/erp",
    secured(async ({ identity, params, body }) => ({
      status: 201,
      body: await erp.connect(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        body,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/erp/:connectionId/test",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await erp.test(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.connectionId,
      ),
    })),
  );
  router.add(
    "POST",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/erp/:connectionId/sync",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await erp.sync(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.connectionId,
        body,
      ),
    })),
  );
  router.add(
    "DELETE",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/erp/:connectionId",
    secured(async ({ identity, params }) => ({
      status: 200,
      body: await erp.disconnect(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        params.connectionId,
      ),
    })),
  );
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/integration-logs",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body: erp.logs(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        url.searchParams.get("limit") || 100,
      ),
    })),
  );
  // Analytics / Metrika + showcase flags
  router.add(
    "GET",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/analytics/settings",
    secured(async ({ identity, params }) => {
      tenancy.context(identity.user.id, params.workspaceId, "manager");
      const shop = store
        .snapshot()
        .shops.find((item) => item.id === params.shopId);
      return {
        status: 200,
        body: {
          metrikaId: shop?.settings?.analytics?.metrikaId || "",
          cartEnabled: shop?.settings?.storefront?.cartEnabled !== false,
          showcaseOnly: shop?.settings?.storefront?.showcaseOnly === true,
        },
      };
    }),
  );
  router.add(
    "PUT",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/analytics/settings",
    secured(async ({ identity, params, body }) => {
      const shop = await tenancy.updateShop(
        identity.user.id,
        params.workspaceId,
        params.shopId,
        {
          settings: {
            analytics: {
              metrikaId: String(body?.metrikaId || "").trim(),
            },
            storefront: {
              cartEnabled: body?.cartEnabled !== false,
              showcaseOnly: body?.showcaseOnly === true,
            },
          },
        },
      );
      return {
        status: 200,
        body: {
          metrikaId: shop.settings?.analytics?.metrikaId || "",
          cartEnabled: shop.settings?.storefront?.cartEnabled !== false,
          showcaseOnly: shop.settings?.storefront?.showcaseOnly === true,
        },
      };
    }),
  );
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
    "PATCH",
    "/api/v6/workspaces/:workspaceId/shops/:shopId/telegram",
    secured(async ({ identity, params, body }) => ({
      status: 200,
      body: await telegram.updateSettings(
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
    "/api/v6/workspaces/:workspaceId/shops/:shopId/analytics/utm",
    secured(async ({ identity, params, url }) => ({
      status: 200,
      body: analytics.utmReport(
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
      requirePermission(identity, params.workspaceId, Permission.OrdersWrite);
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
      const referralSettlement =
        body.status === "completed"
          ? await referrals.settle(order.shopId, order.id)
          : null;
      let referralNotify = null;
      if (referralSettlement?.unlocked && referralSettlement?.referral?.telegram) {
        referralNotify = await telegram.notifyText(
          order.shopId,
          referralSettlement.referral.telegram,
          [
            `🎉 Друг оплатил заказ по вашей ссылке!`,
            `Заказ №${order.number} · ${Number(order.total || 0).toLocaleString("ru-RU")} ₽`,
            `Ваше вознаграждение: ${Number(referralSettlement.entry?.amount || 0).toLocaleString("ru-RU")} ₽`,
            `Продолжайте приглашать друзей — ссылка в личном кабинете «Пригласи друга».`,
          ].join("\n"),
        );
      }
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
          referralSettlement,
          referralNotify,
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
        const { file, mime } = await media.resolveForServe(
          filename,
          url.searchParams.get("w") || url.searchParams.get("width") || 0,
        );
        res.writeHead(200, {
          "content-type": mime,
          "cache-control": "public, max-age=31536000, immutable",
          "access-control-allow-origin": "*",
          vary: "Accept",
        });
        const stream = fs.createReadStream(file);
        stream.on('error', () => res.destroy());
        return stream.pipe(res);
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
      if (result.redirect) {
        res.writeHead(result.status || 302, {
          location: result.redirect,
          "cache-control": "private, max-age=300",
          "x-request-id": requestId,
          "access-control-allow-origin": "*",
        });
        return res.end();
      }
      if (result.raw != null) {
        const payload = Buffer.isBuffer(result.raw)
          ? result.raw
          : Buffer.from(String(result.raw), "utf8");
        res.writeHead(result.status || 200, {
          "content-type":
            result.contentType || "application/octet-stream; charset=utf-8",
          "content-length": payload.length,
          "x-request-id": requestId,
          "access-control-allow-origin": "*",
        });
        return res.end(payload);
      }
      json(res, result.status || 200, result.body, {
        "x-request-id": requestId,
        "access-control-allow-origin": "*",
        ...(result.headers || {}),
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
    telegram,
    services: {
      store,
      auth,
      tenancy,
      catalog,
      media,
      imports,
      importJobs,
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
      mail,
      apiKeys,
      referrals,
      max,
      feeds,
      chats,
      erp,
      support,
    },
  };
}
