import {
    PrismaClient,
    PlanType,
    PaymentType,
    PaymentStatus,
} from "@prisma/client";
import axios from "axios";
import { randomUUID } from "crypto";
import TelegramBot from "node-telegram-bot-api";
import TronWeb from "tronweb";

export class PaymentService {
    private paymentHandlers: any; // Ссылка на PaymentHandlers

    constructor(
        private prisma: PrismaClient,
        private bot: TelegramBot,
        private tronWeb: TronWeb
    ) {}

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
            `Подписка на ${this.getPlanName(planType)}`,
            `Доступ к каналу на ${this.getPlanName(planType)}`,
            payload,
            "",
            "XTR",
            [{ label: "Подписка", amount: price }],
            {
                start_parameter: `payment_${payment.id}`,
            }
        );

        return payment;
    }

    // Создание крипто-платежа
    async createCryptoPayment(
        userId: string,
        planType: PlanType,
        cryptoType: "TRX" | "USDT"
    ) {
        const prices = this.getPlanPrices();
        const amount =
            prices[planType][cryptoType.toLowerCase() as "trx" | "usdt"];

        // Генерируем уникальный адрес или используем основной с memo
        const paymentAddress = await this.generatePaymentAddress();

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
                cryptoAddress: paymentAddress,
                expectedAmount: amount,
                expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 час
            },
        });

        return { payment, address: paymentAddress };
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

        await this.refundStarPayment(
            `${payment.user.telegramId}`,
            telegramPaymentChargeId
        );

        return payment;
    }

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

    // Обработка крипто-платежа
    async handleCryptoPayment(txHash: string) {
        try {
            // Сначала ищем существующий платеж с этим хэшем
            const existingPayment = await this.prisma.payment.findUnique({
                where: { cryptoTxHash: txHash },
            });

            if (existingPayment) {
                console.log(`Transaction ${txHash} already processed`);
                return existingPayment;
            }

            // Получаем информацию о транзакции
            const txInfo = await this.tronWeb.trx.getTransaction(txHash);

            if (
                !txInfo ||
                !txInfo.ret ||
                txInfo.ret[0].contractRet !== "SUCCESS"
            ) {
                throw new Error(`Invalid or failed transaction: ${txHash}`);
            }

            let payment: any = null;

            // Проверяем тип транзакции
            const contract = txInfo.raw_data.contract[0];

            if (contract.type === "TransferContract") {
                // TRX транзакция
                payment = await this.handleTRXTransaction(txInfo, txHash);
            } else if (contract.type === "TriggerSmartContract") {
                // TRC20 транзакция (USDT)
                payment = await this.handleUSDTTransaction(txInfo, txHash);
            } else {
                throw new Error(
                    `Unsupported transaction type: ${contract.type}`
                );
            }

            if (!payment) {
                throw new Error("No matching payment found for transaction");
            }

            // Обновляем платеж и создаем подписку атомарно
            await this.prisma.$transaction(async (tx) => {
                await tx.payment.update({
                    where: { id: payment.id },
                    data: {
                        status: PaymentStatus.COMPLETED,
                        cryptoTxHash: txHash,
                    },
                });

                await this.createSubscription(tx, payment);
            });

            // Уведомляем пользователя о успешном крипто-платеже
            if (this.paymentHandlers) {
                await this.paymentHandlers.handleCryptoPaymentSuccess(
                    payment.userId
                );
            }

            console.log(
                `✅ Successfully processed crypto payment: ${payment.id} (${txHash})`
            );
            return payment;
        } catch (error) {
            console.error(`Error handling crypto payment ${txHash}:`, error);
            throw error;
        }
    }

    private async handleTRXTransaction(txInfo: any, txHash: string) {
        const contract = txInfo.raw_data.contract[0];
        const toAddress = this.tronWeb.address.fromHex(
            contract.parameter.value.to_address
        );
        const amount = contract.parameter.value.amount / 1000000; // Конвертируем в TRX

        // Ищем соответствующий платеж
        const payment = await this.prisma.payment.findFirst({
            where: {
                cryptoAddress: toAddress,
                status: PaymentStatus.PENDING,
                paymentType: PaymentType.CRYPTO_TRX,
                expiresAt: { gte: new Date() },
                // Проверяем сумму с небольшим допуском
                expectedAmount: {
                    gte: amount - 0.01,
                    lte: amount + 0.01,
                },
            },
            include: { user: true },
        });

        if (!payment) {
            console.log(
                `No matching TRX payment found for transaction ${txHash}:`,
                {
                    toAddress,
                    amount,
                    timestamp: new Date(txInfo.block_timestamp),
                }
            );
        }

        return payment;
    }

    private async handleUSDTTransaction(txInfo: any, txHash: string) {
        const contract = txInfo.raw_data.contract[0];

        // Проверяем, что это USDT контракт
        const contractAddress = this.tronWeb.address.fromHex(
            contract.parameter.value.contract_address
        );
        const usdtContractAddress = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

        if (contractAddress !== usdtContractAddress) {
            throw new Error(`Not a USDT transaction: ${contractAddress}`);
        }

        // Декодируем данные транзакции
        const data = contract.parameter.value.data;

        // Проверяем селектор метода transfer (a9059cbb)
        if (!data.startsWith("a9059cbb")) {
            throw new Error("Not a transfer transaction");
        }

        try {
            // Парсим адрес получателя (следующие 64 символа после селектора)
            const toAddressHex = data.slice(8, 72);
            const toAddress = this.tronWeb.address.fromHex(
                "41" + toAddressHex.slice(24)
            );

            // Парсим сумму (следующие 64 символа)
            const amountHex = data.slice(72, 136);
            const amount = parseInt(amountHex, 16) / 1000000; // Конвертируем в USDT

            // Ищем соответствующий платеж
            const payment = await this.prisma.payment.findFirst({
                where: {
                    cryptoAddress: toAddress,
                    status: PaymentStatus.PENDING,
                    paymentType: PaymentType.CRYPTO_USDT,
                    expiresAt: { gte: new Date() },
                    // Проверяем сумму с небольшим допуском
                    expectedAmount: {
                        gte: amount - 0.01,
                        lte: amount + 0.01,
                    },
                },
                include: { user: true },
            });

            if (!payment) {
                console.log(
                    `No matching USDT payment found for transaction ${txHash}:`,
                    {
                        toAddress,
                        amount,
                        timestamp: new Date(txInfo.block_timestamp),
                    }
                );
            }

            return payment;
        } catch (error) {
            console.error("Error parsing USDT transaction data:", error);
            throw new Error("Failed to parse USDT transaction");
        }
    }

    private async createSubscription(tx: any, payment: any) {
        const duration = this.getPlanDuration(payment.planType);
        const channelId = process.env.CHANNEL_ID!;
        await this.bot.unbanChatMember(
            channelId,
            payment.user.telegramId as any
        );
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
                    // paymentId не обновляем - оставляем исходный
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

    private getPlanPrices() {
        // const prices = {
        //     [PlanType.DAY]: { stars: 399, trx: 10, usdt: 10 },
        //     [PlanType.WEEK]: { stars: 599, trx: 60, usdt: 19 },
        //     [PlanType.MONTH]: { stars: 2500, trx: 200, usdt: 50 },
        // };
        // TODO - test data
        const prices = {
            [PlanType.DAY]: { stars: 1, trx: 10, usdt: 0.1 },
            [PlanType.WEEK]: { stars: 1, trx: 60, usdt: 0.1 },
            [PlanType.MONTH]: { stars: 1, trx: 200, usdt: 0.1 },
        };
        return prices;
    }

    private getPlanDuration(planType: PlanType): number {
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

    private getPlanName(planType: PlanType): string {
        const names = {
            [PlanType.DAY]: "сутки",
            [PlanType.WEEK]: "неделю",
            [PlanType.MONTH]: "месяц",
        };
        return names[planType];
    }

    private generatePaymentAddress(): string {
        return process.env.CRYPTO_WALLET_ADDRESS!;
    }
}
