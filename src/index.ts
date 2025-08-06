import TelegramBot from "node-telegram-bot-api";
import { PrismaClient } from "@prisma/client";
import { PaymentService, CryptoMonitor, NOWPaymentsService } from "./services";
import { PaymentHandlers } from "./handlers";
import cron from "node-cron";
class SubscriptionBot {
    private bot: TelegramBot;
    private prisma: PrismaClient;
    private paymentService: PaymentService;
    private paymentHandlers: PaymentHandlers;
    private cryptoMonitor: CryptoMonitor;

    constructor() {
        this.prisma = new PrismaClient();
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, {
            polling: true,
        });

        this.paymentService = new PaymentService(this.prisma, this.bot);

        this.paymentHandlers = new PaymentHandlers(
            this.bot,
            this.paymentService,
            this.prisma
        );

        // Устанавливаем связь между сервисами
        this.paymentService.setPaymentHandlers(this.paymentHandlers);

        this.cryptoMonitor = new CryptoMonitor(
            this.prisma,
            this.paymentService
        );

        this.setupScheduledTasks();
    }

    private setupScheduledTasks() {
        // Очистка просроченных платежей каждые 5 минут
        cron.schedule("*/5 * * * *", async () => {
            try {
                await this.paymentService.cleanupExpiredPayments();
                await this.cryptoMonitor.cleanupExpiredPayments();
                console.log("✅ Expired payments cleaned up");
            } catch (error) {
                console.error("❌ Error cleaning expired payments:", error);
            }
        });

        // Мониторинг крипто-платежей каждые 2 минуты
        cron.schedule("*/2 * * * *", async () => {
            try {
                await this.cryptoMonitor.checkPendingPayments();
            } catch (error) {
                console.error("❌ Error monitoring crypto payments:", error);
            }
        });

        // Проверка истекших подписок каждый час
        cron.schedule("0 * * * *", async () => {
            try {
                await this.removeExpiredSubscriptions();
            } catch (error) {
                console.error(
                    "❌ Error removing expired subscriptions:",
                    error
                );
            }
        });

        // Статистика платежей каждые 6 часов
        cron.schedule("0 */6 * * *", async () => {
            try {
                await this.cryptoMonitor.getPaymentStats();
            } catch (error) {
                console.error("❌ Error getting payment stats:", error);
            }
        });
    }

    private async removeExpiredSubscriptions() {
        const expiredSubscriptions = await this.prisma.subscription.findMany({
            where: {
                endDate: { lt: new Date() },
                isActive: true,
            },
            include: { user: true },
        });

        let processedCount = 0;

        for (const subscription of expiredSubscriptions) {
            try {
                // Деактивируем подписку
                await this.prisma.subscription.update({
                    where: { id: subscription.id },
                    data: { isActive: false },
                });

                // Баним пользователя в канале
                try {
                    await this.bot.banChatMember(
                        process.env.CHANNEL_ID!,
                        Number(subscription.user.telegramId)
                    );
                } catch (banError) {
                    console.log(
                        `Could not ban user ${subscription.user.telegramId}:`,
                        banError.message
                    );
                }

                // Уведомляем пользователя об истечении подписки
                try {
                    await this.bot.sendMessage(
                        Number(subscription.user.telegramId),
                        "⏰ Ваша подписка истекла. Для продления доступа к каналу оформите новую подписку командой /start"
                    );
                } catch (msgError) {
                    console.log(
                        `Could not send expiry message to user ${subscription.user.telegramId}:`,
                        msgError.message
                    );
                }

                processedCount++;
                console.log(
                    `🔄 Deactivated expired subscription for user ${subscription.user.telegramId}`
                );

                // Небольшая пауза между операциями
                await new Promise((resolve) => setTimeout(resolve, 100));
            } catch (error) {
                console.error(
                    `❌ Error processing expired subscription for user ${subscription.user.telegramId}:`,
                    error
                );
            }
        }

        if (processedCount > 0) {
            console.log(`📊 Processed ${processedCount} expired subscriptions`);
        }
    }

    async start() {
        try {
            // Проверяем подключение к БД
            await this.prisma.$connect();
            console.log("✅ Database connected");

            // Проверяем токен бота
            const botInfo = await this.bot.getMe();
            console.log(`✅ Bot connected: @${botInfo.username}`);

            // Проверяем переменные окружения
            this.checkEnvironmentVariables();

            // Проверяем NOWPayments API
            await this.checkNOWPaymentsAPI();

            console.log("🚀 Subscription bot started successfully!");

            // Выводим статистику при старте
            setTimeout(async () => {
                try {
                    await this.cryptoMonitor.getPaymentStats();
                } catch (error) {
                    console.error("Error getting initial stats:", error);
                }
            }, 5000);
        } catch (error) {
            console.error("❌ Error starting bot:", error);
            process.exit(1);
        }
    }

    private async checkNOWPaymentsAPI() {
        try {
            const nowPayments = new NOWPaymentsService(
                process.env.NOWPAYMENTS_API_KEY!
            );

            const isAvailable = await nowPayments.checkApiStatus();
            if (isAvailable) {
                console.log("✅ NOWPayments API is available");

                // Проверяем доступные валюты
                try {
                    const currencies =
                        await nowPayments.getAvailableCurrencies();
                    const hasUSDTTRC20 = currencies.includes("usdttrc20");

                    if (hasUSDTTRC20) {
                        console.log("✅ USDT TRC20 is supported");
                    } else {
                        console.warn(
                            "⚠️ USDT TRC20 may not be available, check your NOWPayments account"
                        );
                        console.log(
                            "Available currencies:",
                            currencies.slice(0, 10).join(", "),
                            "..."
                        );
                    }
                } catch (currencyError) {
                    console.warn(
                        "⚠️ Could not check available currencies:",
                        currencyError.message
                    );
                }
            } else {
                throw new Error("NOWPayments API is not available");
            }
        } catch (error) {
            console.error("❌ NOWPayments API check failed:", error.message);
            console.warn("⚠️ Bot will start but crypto payments may not work");
        }
    }

    private checkEnvironmentVariables() {
        const requiredVars = [
            "TELEGRAM_BOT_TOKEN",
            "DATABASE_URL",
            "CHANNEL_ID",
            "NOWPAYMENTS_API_KEY",
        ];

        const missingVars = requiredVars.filter(
            (varName) => !process.env[varName]
        );

        if (missingVars.length > 0) {
            console.error(
                "❌ Missing required environment variables:",
                missingVars.join(", ")
            );
            process.exit(1);
        }

        console.log("✅ All required environment variables are set");
    }

    async stop() {
        console.log("🛑 Shutting down bot...");

        try {
            await this.prisma.$disconnect();
            console.log("✅ Database disconnected");

            await this.bot.stopPolling();
            console.log("✅ Bot polling stopped");
        } catch (error) {
            console.error("❌ Error during shutdown:", error);
        }
    }
}

// Запуск бота
const bot = new SubscriptionBot();
bot.start();

// Graceful shutdown
process.on("SIGINT", async () => {
    console.log("\n🛑 Received SIGINT, shutting down gracefully...");
    await bot.stop();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    console.log("\n🛑 Received SIGTERM, shutting down gracefully...");
    await bot.stop();
    process.exit(0);
});

// Обработка необработанных ошибок
process.on("unhandledRejection", (reason, promise) => {
    console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
    console.error("❌ Uncaught Exception:", error);
    process.exit(1);
});
