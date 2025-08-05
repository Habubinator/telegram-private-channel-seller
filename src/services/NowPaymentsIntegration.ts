import {
    PrismaClient,
    PlanType,
    PaymentType,
    PaymentStatus,
} from "@prisma/client";
import { NowPaymentsService } from "./CryptoPaymentGateways";
import TelegramBot from "node-telegram-bot-api";

export class NowPaymentsIntegration {
    private nowPayments: NowPaymentsService;

    constructor(
        private prisma: PrismaClient,
        private bot: TelegramBot,
        apiKey: string
    ) {
        this.nowPayments = new NowPaymentsService(apiKey);
    }

    // Обновленный метод создания крипто-платежа
    async createCryptoPayment(
        userId: string,
        planType: PlanType,
        cryptoType: "TRX" | "USDT"
    ) {
        try {
            const prices = this.getPlanPrices();
            const amount =
                prices[planType][cryptoType.toLowerCase() as "trx" | "usdt"];

            // Создаем запись платежа в БД
            const payment = await this.prisma.payment.create({
                data: {
                    userId,
                    amount,
                    currency: cryptoType,
                    planType,
                    paymentType:
                        cryptoType === "TRX"
                            ? PaymentType.CRYPTO_TRX
                            : PaymentType.CRYPTO_USDT,
                    expectedAmount: amount,
                    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 час
                },
            });

            // Создаем платеж через NowPayments
            const nowPayment = await this.nowPayments.createPayment(
                payment.id,
                amount,
                cryptoType === "TRX" ? "trx" : "usdttrc20",
                `Подписка на ${this.getPlanName(planType)}`
            );

            // Обновляем запись платежа
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: {
                    cryptoAddress: nowPayment.payToAddress,
                    // Сохраняем ID платежа NowPayments для отслеживания
                    invoicePayload: nowPayment.paymentId,
                },
            });

            return {
                payment: {
                    ...payment,
                    cryptoAddress: nowPayment.payToAddress,
                },
                paymentUrl: nowPayment.paymentUrl,
                payToAddress: nowPayment.payToAddress,
                payAmount: nowPayment.payAmount,
            };
        } catch (error) {
            console.error("Error creating NowPayments payment:", error);
            throw error;
        }
    }

    // Webhook обработчик для NowPayments
    async handleWebhook(signature: string, payload: any) {
        try {
            // Проверяем подпись webhook
            if (
                !this.nowPayments.verifyWebhook(
                    signature,
                    JSON.stringify(payload)
                )
            ) {
                console.error("Invalid webhook signature");
                return false;
            }

            const { order_id, payment_status, pay_amount, pay_currency } =
                payload;

            if (payment_status === "finished") {
                // Платеж завершен успешно
                const payment = await this.prisma.payment.findUnique({
                    where: { id: order_id },
                    include: { user: true },
                });

                if (!payment) {
                    console.error(`Payment not found: ${order_id}`);
                    return false;
                }

                // Обновляем статус платежа
                await this.prisma.$transaction(async (tx) => {
                    await tx.payment.update({
                        where: { id: payment.id },
                        data: {
                            status: PaymentStatus.COMPLETED,
                            cryptoTxHash: payload.payment_id, // ID транзакции от NowPayments
                        },
                    });

                    // Создаем подписку
                    await this.createSubscription(tx, payment);
                });

                // Уведомляем пользователя
                await this.notifyUserSuccess(payment);

                console.log(`✅ NowPayments payment completed: ${order_id}`);
                return true;
            }

            return false;
        } catch (error) {
            console.error("Error handling NowPayments webhook:", error);
            return false;
        }
    }

    private async createSubscription(tx: any, payment: any) {
        const duration = this.getPlanDuration(payment.planType);
        const channelId = process.env.CHANNEL_ID!;

        // Ищем существующую активную подписку
        const existingSubscription = await tx.subscription.findFirst({
            where: {
                userId: payment.userId,
                channelId: channelId,
                isActive: true,
                endDate: { gte: new Date() },
            },
            orderBy: { endDate: "desc" },
        });

        let startDate: Date;
        let endDate: Date;

        if (existingSubscription) {
            // Продление подписки
            startDate = existingSubscription.endDate;
            endDate = new Date(startDate.getTime() + duration);

            await tx.subscription.update({
                where: { id: existingSubscription.id },
                data: {
                    endDate: endDate,
                    planType: payment.planType,
                },
            });
        } else {
            // Новая подписка
            startDate = new Date();
            endDate = new Date(startDate.getTime() + duration);

            await tx.subscription.create({
                data: {
                    userId: payment.userId,
                    channelId: channelId,
                    planType: payment.planType,
                    startDate,
                    endDate,
                    paymentId: payment.id,
                },
            });
        }
    }

    private async notifyUserSuccess(payment: any) {
        try {
            const inviteLink = await this.createInviteLink();

            const keyboard = {
                inline_keyboard: [
                    [{ text: "🔗 Войти в канал", url: inviteLink }],
                ],
            };

            await this.bot.sendMessage(
                Number(payment.user.telegramId),
                "✅ Криптоплатеж успешно обработан! Вы получили доступ к каналу.",
                { reply_markup: keyboard }
            );
        } catch (error) {
            console.error("Error notifying user:", error);
        }
    }

    private async createInviteLink(): Promise<string> {
        try {
            const inviteLink = await this.bot.createChatInviteLink(
                process.env.CHANNEL_ID!,
                {
                    name: `Invite_${Date.now()}`,
                    expire_date: Math.floor(Date.now() / 1000) + 600, // 10 минут
                    member_limit: 1,
                    creates_join_request: false,
                }
            );
            return inviteLink.invite_link;
        } catch (error) {
            console.error("Error creating invite link:", error);
            return `https://t.me/${process.env.CHANNEL_USERNAME}`;
        }
    }

    private getPlanPrices() {
        return {
            [PlanType.DAY]: { stars: 1, trx: 10, usdt: 0.5 },
            [PlanType.WEEK]: { stars: 5, trx: 60, usdt: 2 },
            [PlanType.MONTH]: { stars: 15, trx: 200, usdt: 5 },
        };
    }

    private getPlanDuration(planType: PlanType): number {
        return {
            [PlanType.DAY]: 24 * 60 * 60 * 1000,
            [PlanType.WEEK]: 7 * 24 * 60 * 60 * 1000,
            [PlanType.MONTH]: 30 * 24 * 60 * 60 * 1000,
        }[planType];
    }

    private getPlanName(planType: PlanType): string {
        return {
            [PlanType.DAY]: "сутки",
            [PlanType.WEEK]: "неделю",
            [PlanType.MONTH]: "месяц",
        }[planType];
    }
}

// Webhook endpoint для Express.js
export function setupNowPaymentsWebhook(
    app: any,
    integration: NowPaymentsIntegration
) {
    app.post("/webhooks/nowpayments", async (req: any, res: any) => {
        try {
            const signature = req.headers["x-nowpayments-sig"];
            const success = await integration.handleWebhook(
                signature,
                req.body
            );

            if (success) {
                res.status(200).send("OK");
            } else {
                res.status(400).send("Invalid webhook");
            }
        } catch (error) {
            console.error("Webhook error:", error);
            res.status(500).send("Internal error");
        }
    });
}
