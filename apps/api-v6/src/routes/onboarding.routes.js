import { assert } from "../core/errors.js";

function normalizeToken(value) {
  const token = String(value || "").trim();

  assert(
    /^\d+:[A-Za-z0-9_-]{20,}$/.test(token),
    "TELEGRAM_TOKEN_INVALID",
    "Некорректный токен Telegram",
  );

  return token;
}

export function registerOnboardingRoutes(
  router,
  { tenancy, telegram },
  secured,
) {
  router.add(
    "POST",
    "/api/v6/onboarding/verify-bot",
    secured(async ({ body }) => {
      const token = normalizeToken(body.token);
      const bot = await telegram.api(token, "getMe");

      return {
        status: 200,
        body: {
          valid: true,
          bot: {
            id: String(bot.id),
            username: bot.username || "",
            firstName: bot.first_name || "",
          },
        },
      };
    }),
  );

  router.add(
    "POST",
    "/api/v6/onboarding/create",
    secured(async ({ identity, body }) => {
      const workspaceId = String(body.workspaceId || "").trim();
      const token = normalizeToken(body.token);
      const name = String(body.name || "").trim();

      assert(
        workspaceId,
        "WORKSPACE_REQUIRED",
        "Не указано рабочее пространство",
      );

      assert(
        name.length >= 2,
        "SHOP_NAME_REQUIRED",
        "Укажите название магазина",
      );

      const bot = await telegram.api(token, "getMe");

      const shop = await tenancy.createShop(
        identity.user.id,
        workspaceId,
        {
          name,
          slug: body.slug,
        },
      );

      const telegramConfig = await telegram.connect(
        identity.user.id,
        workspaceId,
        shop.id,
        {
          token,
          adminChatId: body.adminChatId,
          webhookUrl: body.webhookUrl,
          webhookSecret: body.webhookSecret,
          enabled: body.enabled !== false,
        },
      );

      return {
        status: 201,
        body: {
          shop,
          telegram: telegramConfig,
          bot: {
            id: String(bot.id),
            username: bot.username || "",
            firstName: bot.first_name || "",
          },
          nextStep: "catalog",
        },
      };
    }),
  );
}