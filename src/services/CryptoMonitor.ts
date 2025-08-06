import { PrismaClient, PaymentStatus, PaymentType } from "@prisma/client";
import { PaymentService } from "./PaymentService";

export class CryptoMonitor {
    constructor(
        private prisma: PrismaClient,
        private paymentService: PaymentService
    ) {}

    /**
     * Проверяет все pending крипто-платежи через NOWPayments API
     */
    async checkPendingPayments() {
        try {
            console.log("🔄 Checking pending crypto payments...");

            // Получаем все pending крипто-платежи
            const pendingPayments = await this.prisma.payment.findMany({
                where: {
                    status: PaymentStatus.PENDING,
                    paymentType: PaymentType.CRYPTO_USDT,
                    expiresAt: { gte: new Date() },
                    cryptoTxHash: { not: null }, // У нас есть payment_id от NOWPayments
                },
            });

            console.log(
                `Found ${pendingPayments.length} pending crypto payments`
            );

            let checkedCount = 0;
            let completedCount = 0;
            let failedCount = 0;

            for (const payment of pendingPayments) {
                try {
                    const result =
                        await this.paymentService.checkCryptoPaymentStatus(
                            payment.cryptoTxHash!
                        );

                    checkedCount++;

                    if (result.statusChanged) {
                        if (result.nowPayment.payment_status === "finished") {
                            completedCount++;
                            console.log(
                                `✅ Payment completed: ${payment.cryptoTxHash}`
                            );
                        } else if (
                            ["failed", "refunded", "expired"].includes(
                                result.nowPayment.payment_status
                            )
                        ) {
                            failedCount++;
                            console.log(
                                `❌ Payment failed: ${payment.cryptoTxHash} (${result.nowPayment.payment_status})`
                            );
                        }
                    }

                    // Небольшая пауза между запросами, чтобы не нагружать API
                    await this.sleep(500);
                } catch (error) {
                    console.error(
                        `Error checking payment ${payment.cryptoTxHash}:`,
                        error
                    );
                }
            }

            if (checkedCount > 0) {
                console.log(
                    `📊 Crypto payments check completed: ${checkedCount} checked, ${completedCount} completed, ${failedCount} failed`
                );
            }
        } catch (error) {
            console.error("Error in crypto payments monitoring:", error);
        }
    }

    /**
     * Помощная функция для паузы
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Очистка истекших платежей
     */
    async cleanupExpiredPayments() {
        try {
            const expiredCount = await this.prisma.payment.updateMany({
                where: {
                    status: PaymentStatus.PENDING,
                    expiresAt: { lt: new Date() },
                },
                data: {
                    status: PaymentStatus.EXPIRED,
                },
            });

            if (expiredCount.count > 0) {
                console.log(
                    `🧹 Marked ${expiredCount.count} payments as expired`
                );
            }
        } catch (error) {
            console.error("Error cleaning up expired payments:", error);
        }
    }

    /**
     * Получение статистики платежей
     */
    async getPaymentStats() {
        try {
            const stats = await this.prisma.payment.groupBy({
                by: ["status", "paymentType"],
                _count: {
                    id: true,
                },
                where: {
                    createdAt: {
                        gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // За последние 24 часа
                    },
                },
            });

            console.log("📈 Payment stats (last 24h):");
            for (const stat of stats) {
                console.log(
                    `  ${stat.paymentType} - ${stat.status}: ${stat._count.id}`
                );
            }

            return stats;
        } catch (error) {
            console.error("Error getting payment stats:", error);
            return [];
        }
    }
}
