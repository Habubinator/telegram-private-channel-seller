import {
    PrismaClient,
    PlanType,
    PaymentType,
    PaymentStatus,
} from "@prisma/client";
import axios from "axios";
import { randomUUID } from "crypto";
import TelegramBot from "node-telegram-bot-api";
import { NOWPaymentsService, NOWPayment } from "./NOWPaymentsService";

export class PaymentService {
    private paymentHandlers: any; // Ссылка на PaymentHandlers
    private nowPayments: NOWPaymentsService;

    constructor(private prisma: PrismaClient, private bot: TelegramBot) {
        this.nowPayments = new NOWPaymentsService(
            process.env.NOWPAYMENTS_API_KEY!
        );
    }

    // Метод для установки ссылки на PaymentHandlers
    setPaymentHandlers(paymentHandlers: any) {
        this.paymentHandlers = paymentHandlers;
    }

    // Генерация уникального payload для избежания коллизий
    private generateUniquePayload(): string {
        return `payment_${Date.now()}_${randomUUID().slice(0, 8)}`;
    }

    // Создание платежа через звезды Telegram
    async createTelegramStarsPayment(
        userId: string,
        telegramId: number,
        planType: PlanType
    ) {
        const prices = this.getPlanPrices();
        const price = prices[planType].stars;
        const payload = this.generateUniquePayload();

        // Создаем запись о платеже в БД
        const payment = await this.prisma.payment.create({
            data: {
                userId,
                amount: price,
                currency: "XTR", // Telegram Stars
                planType,
                paymentType: PaymentType.TELEGRAM_STARS,
                invoicePayload: payload,
                expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 минут
            },
        });

        // Отправляем инвойс
        await this.bot.sendInvoice(
            telegramId,
            `Subscription for ${this.getPlanName(planType)}`,
            `Channel permission for ${this.getPlanName(planType)}`,
            payload,
            "",
            "XTR",
            [{ label: "Subscription", amount: price }],
            {
                start_parameter: `payment_${payment.id}`,
            }
        );

        return payment;
    }

    // Создание крипто-платежа через NOWPayments
    async createCryptoPayment(userId: string, planType: PlanType) {
        try {
            const prices = this.getPlanPrices();
            const usdAmount = prices[planType].usdt;

            const orderId = `order_${Date.now()}_${randomUUID().slice(0, 8)}`;

            // Проверяем минимальную сумму заранее
            try {
                const minAmount =
                    await this.nowPayments.getMinimumPaymentAmount(
                        "USDTTRC20",
                        "USDTTRC20"
                    );
                console.log(`💰 Minimum payment amount: ${minAmount} USD`);

                if (usdAmount < minAmount) {
                    throw new Error(
                        `Payment amount ${usdAmount} USD is less than minimum ${minAmount} USD`
                    );
                }
            } catch (minError) {
                console.log(
                    "⚠️ Could not check minimum amount, proceeding anyway:",
                    minError.message
                );
            }

            // Создаем платеж в NOWPayments
            console.log(`🔄 Creating payment for ${usdAmount} USD`);

            const nowPayment = await this.nowPayments.createPayment({
                price_amount: usdAmount,
                price_currency: "USDTTRC20",
                pay_currency: "USDTTRC20", // Используем только USDTTRC20, так как он поддерживается
                order_id: orderId,
                order_description: `Subscription for ${this.getPlanName(
                    planType
                )}`,
            });

            // Создаем запись о платеже в нашей БД
            const payment = await this.prisma.payment.create({
                data: {
                    userId,
                    amount: nowPayment.pay_amount,
                    currency: "USDTTRC20",
                    planType,
                    paymentType: PaymentType.CRYPTO_USDT,
                    cryptoAddress: nowPayment.pay_address,
                    expectedAmount: nowPayment.pay_amount,
                    cryptoTxHash: nowPayment.payment_id, // Используем payment_id как идентификатор
                    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 час
                },
            });

            return {
                payment,
                nowPayment,
                address: nowPayment.pay_address,
                amount: nowPayment.pay_amount,
                paymentId: nowPayment.payment_id,
            };
        } catch (error) {
            console.error("Error creating NOWPayments payment:", error);
            throw new Error("Failed to create crypto payment");
        }
    }

    // Проверка статуса крипто-платежа
    async checkCryptoPaymentStatus(paymentId: string) {
        try {
            // Получаем наш платеж из БД
            const payment = await this.prisma.payment.findUnique({
                where: { cryptoTxHash: paymentId },
                include: { user: true },
            });

            if (!payment) {
                throw new Error("Payment not found");
            }

            // Получаем статус из NOWPayments
            const nowPayment = await this.nowPayments.getPaymentStatus(
                paymentId
            );

            let statusChanged = false;

            // Проверяем, нужно ли обновить статус
            if (
                nowPayment.payment_status === "finished" &&
                payment.status === PaymentStatus.PENDING
            ) {
                await this.prisma.$transaction(async (tx) => {
                    // Обновляем платеж
                    await tx.payment.update({
                        where: { id: payment.id },
                        data: {
                            status: PaymentStatus.COMPLETED,
                        },
                    });

                    // Создаем подписку
                    await this.createSubscription(tx, payment);
                });

                // Уведомляем пользователя о успешном платеже
                if (this.paymentHandlers) {
                    await this.paymentHandlers.handleCryptoPaymentSuccess(
                        payment.userId
                    );
                }

                statusChanged = true;
                console.log(`✅ Crypto payment completed: ${paymentId}`);
            } else if (
                ["failed", "refunded", "expired"].includes(
                    nowPayment.payment_status
                ) &&
                payment.status === PaymentStatus.PENDING
            ) {
                await this.prisma.payment.update({
                    where: { id: payment.id },
                    data: {
                        status: PaymentStatus.FAILED,
                    },
                });
                statusChanged = true;
                console.log(
                    `❌ Crypto payment failed: ${paymentId} (${nowPayment.payment_status})`
                );
            }

            return {
                payment,
                nowPayment,
                statusChanged,
            };
        } catch (error) {
            console.error(`Error checking payment status ${paymentId}:`, error);
            throw error;
        }
    }

    // Обработка успешного платежа звездами
    async handleTelegramStarsSuccess(
        payload: string,
        telegramPaymentChargeId: string
    ) {
        const payment = await this.prisma.payment.findUnique({
            where: { invoicePayload: payload },
            include: { user: true },
        });

        if (!payment || payment.status !== PaymentStatus.PENDING) {
            throw new Error("Payment not found or already processed");
        }

        // Атомарное обновление статуса и создание подписки
        await this.prisma.$transaction(async (tx) => {
            // Обновляем платеж
            await tx.payment.update({
                where: { id: payment.id },
                data: {
                    status: PaymentStatus.COMPLETED,
                    telegramPaymentChargeId,
                },
            });

            // Создаем подписку
            await this.createSubscription(tx, payment);
        });

        // TODO TEST
        // await this.refundStarPayment(
        //     `${payment.user.telegramId}`,
        //     telegramPaymentChargeId
        // );
        return payment;
    }

    // Рефанд звезд
    async refundStarPayment(
        userId: string,
        telegramPaymentChargeId: string
    ): Promise<boolean> {
        try {
            const response = await axios.post(
                `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/refundStarPayment`,
                {
                    user_id: userId,
                    telegram_payment_charge_id: telegramPaymentChargeId,
                }
            );

            if (response.data.ok) {
                console.log("Refund successful:", response.data.result);
                return true;
            } else {
                console.error("Refund failed:", response.data.description);
                return false;
            }
        } catch (error) {
            console.error(
                "Error occurred during refund:",
                error.response?.data || error.message
            );
            return false;
        }
    }

    private async createSubscription(tx: any, payment: any) {
        const duration = this.getPlanDuration(payment.planType);
        const channelId = process.env.CHANNEL_ID!;

        try {
            await this.bot.unbanChatMember(
                channelId,
                payment.user.telegramId as any
            );
        } catch (error) {
            console.log(
                "User was not banned or error unbanning:",
                error.message
            );
        }

        // Ищем существующую активную подписку пользователя
        const existingSubscription = await tx.subscription.findFirst({
            where: {
                userId: payment.userId,
                channelId: channelId,
                isActive: true,
                endDate: { gte: new Date() }, // Подписка еще действует
            },
            orderBy: {
                endDate: "desc", // Берем самую позднюю подписку
            },
        });

        let startDate: Date;
        let endDate: Date;
        let subscription: any;

        if (existingSubscription) {
            // ПРОДЛЕНИЕ: начинаем с окончания текущей подписки
            startDate = existingSubscription.endDate;
            endDate = new Date(startDate.getTime() + duration);

            // Обновляем существующую подписку
            subscription = await tx.subscription.update({
                where: { id: existingSubscription.id },
                data: {
                    endDate: endDate,
                    planType: payment.planType, // Обновляем план на новый
                },
            });

            console.log(
                `🔄 Subscription extended for user ${
                    payment.userId
                }: ${existingSubscription.endDate.toISOString()} → ${endDate.toISOString()}`
            );
        } else {
            // НОВАЯ ПОДПИСКА: начинаем с текущего момента
            startDate = new Date();
            endDate = new Date(startDate.getTime() + duration);

            subscription = await tx.subscription.create({
                data: {
                    userId: payment.userId,
                    channelId: channelId,
                    planType: payment.planType,
                    startDate,
                    endDate,
                    paymentId: payment.id,
                },
            });

            console.log(
                `✨ New subscription created for user ${
                    payment.userId
                }: ${startDate.toISOString()} → ${endDate.toISOString()}`
            );
        }

        return subscription;
    }

    // Очистка просроченных платежей
    async cleanupExpiredPayments() {
        await this.prisma.payment.updateMany({
            where: {
                status: PaymentStatus.PENDING,
                expiresAt: { lt: new Date() },
            },
            data: {
                status: PaymentStatus.EXPIRED,
            },
        });
    }

    getPlanPrices() {
        // const prices = {
        //     [PlanType.DAY]: { stars: 1, usdt: 21 },
        //     [PlanType.WEEK]: { stars: 1, usdt: 30 },
        //     [PlanType.MONTH]: { stars: 1, usdt: 61 },
        // };

        // TODO Продакшн цены:
        const prices = {
            [PlanType.DAY]: { stars: 399, usdt: 21 },
            [PlanType.WEEK]: { stars: 599, usdt: 30 },
            [PlanType.MONTH]: { stars: 2500, usdt: 61 },
        };

        return prices;
    }

    getPlanDuration(planType: PlanType): number {
        const durations = {
            [PlanType.DAY]: 24 * 60 * 60 * 1000,
            [PlanType.WEEK]: 7 * 24 * 60 * 60 * 1000,
            [PlanType.MONTH]: 30 * 24 * 60 * 60 * 1000,
        };

        // TODO - test data
        // const durations = {
        //     [PlanType.DAY]: 60 * 5 * 1000,
        //     [PlanType.WEEK]: 60 * 10 * 1000,
        //     [PlanType.MONTH]: 60 * 15 * 1000,
        // };

        return durations[planType];
    }

    getPlanName(planType: PlanType): string {
        const names = {
            [PlanType.DAY]: "day",
            [PlanType.WEEK]: "week",
            [PlanType.MONTH]: "month",
        };
        return names[planType];
    }
}
