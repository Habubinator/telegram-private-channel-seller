import TelegramBot from "node-telegram-bot-api";
import { PrismaClient } from "@prisma/client";
import TronWeb from "tronweb";
import { PaymentService, CryptoMonitor } from "./services";
import { PaymentHandlers } from "./handlers";
import cron from "node-cron";

class SubscriptionBot {
    private bot: TelegramBot;
    private prisma: PrismaClient;
    private tronWeb: TronWeb;
    private paymentService: PaymentService;
    private paymentHandlers: PaymentHandlers;
    private cryptoMonitor: CryptoMonitor;

    constructor() {
        this.prisma = new PrismaClient();
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, {
            polling: true,
        });

        this.tronWeb = new TronWeb({
            fullHost: "https://api.trongrid.io",
            headers: { "TRON-PRO-API-KEY": process.env.TRON_PRIVATE_KEY },
            // privateKey: process.env.CRYPTO_WALLET_PRIVATE_KEY,
        });

        this.paymentService = new PaymentService(
            this.prisma,
            this.bot,
            this.tronWeb
        );

        this.paymentHandlers = new PaymentHandlers(
            this.bot,
            this.paymentService,
            this.prisma
        );

        // Устанавливаем связь между сервисами
        this.paymentService.setPaymentHandlers(this.paymentHandlers);

        this.cryptoMonitor = new CryptoMonitor(
            this.prisma,
            this.tronWeb,
            this.paymentService
        );

        this.setupScheduledTasks();
    }

    private setupScheduledTasks() {
        // Очистка просроченных платежей каждые 5 минут
        cron.schedule("*/5 * * * *", async () => {
            try {
                await this.paymentService.cleanupExpiredPayments();
                console.log("Expired payments cleaned up");
            } catch (error) {
                console.error("Error cleaning expired payments:", error);
            }
        });

        // Мониторинг крипто-транзакций каждые 30 секунд
        cron.schedule("*/30 * * * * *", async () => {
            try {
                await this.cryptoMonitor.checkPendingPayments();
            } catch (error) {
                console.error("Error monitoring crypto payments:", error);
            }
        });

        // Проверка истекших подписок каждый час
        cron.schedule("/5 * * * *", async () => {
            try {
                await this.removeExpiredSubscriptions();
            } catch (error) {
                console.error("Error removing expired subscriptions:", error);
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

        for (const subscription of expiredSubscriptions) {
            try {
                // Деактивируем подписку (пользователь будет автоматически отклонен при следующей попытке входа)
                await this.prisma.subscription.update({
                    where: { id: subscription.id },
                    data: { isActive: false },
                });

                // Опционально: уведомляем пользователя об истечении подписки
                await this.bot.sendMessage(
                    Number(subscription.user.telegramId),
                    "⏰ Ваша подписка истекла. Для продления доступа к каналу оформите новую подписку командой /start"
                );

                console.log(
                    `Deactivated expired subscription for user ${subscription.user.telegramId}`
                );
            } catch (error) {
                console.error(
                    `Error processing expired subscription for user ${subscription.user.telegramId}:`,
                    error
                );
            }
        }
    }

    async start() {
        try {
            await this.prisma.$connect();
            console.log("Bot started successfully");
        } catch (error) {
            console.error("Error starting bot:", error);
            process.exit(1);
        }
    }

    async stop() {
        await this.prisma.$disconnect();
        await this.bot.stopPolling();
    }
}

// Запуск бота
const bot = new SubscriptionBot();
bot.start();

// Graceful shutdown
process.on("SIGINT", async () => {
    console.log("Shutting down bot...");
    await bot.stop();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    console.log("Shutting down bot...");
    await bot.stop();
    process.exit(0);
});
