import { PrismaClient, PaymentStatus, PaymentType } from "@prisma/client";
import TronWeb from "tronweb";
import { PaymentService } from "./PaymentService";

// TODO - хуйня не работает

export class CryptoMonitor {
    private processedTxs = new Set<string>();

    constructor(
        private prisma: PrismaClient,
        private tronWeb: TronWeb,
        private paymentService: PaymentService
    ) {}

    async checkPendingPayments() {
        try {
            // Получаем все активные крипто-платежи
            const pendingPayments = await this.prisma.payment.findMany({
                where: {
                    status: PaymentStatus.PENDING,
                    paymentType: {
                        in: [PaymentType.CRYPTO_TRX, PaymentType.CRYPTO_USDT],
                    },
                    expiresAt: { gte: new Date() },
                },
            });

            for (const payment of pendingPayments) {
                await this.checkPaymentTransactions(payment);
            }
        } catch (error) {
            console.error("Error checking pending payments:", error);
        }
    }

    private async checkPaymentTransactions(payment: any) {
        try {
            if (payment.paymentType === PaymentType.CRYPTO_TRX) {
                await this.checkTRXTransactions(payment);
            } else if (payment.paymentType === PaymentType.CRYPTO_USDT) {
                await this.checkUSDTTransactions(payment);
            }
        } catch (error) {
            console.error(
                `Error checking transactions for payment ${payment.id}:`,
                error
            );
        }
    }

    private async checkTRXTransactions(payment: any) {
        try {
            // Получаем транзакции адреса с помощью правильного API
            const response = await this.tronWeb.fullNode.request(
                "v1/accounts/" + payment.cryptoAddress + "/transactions",
                {
                    limit: 20,
                    only_to: true, // Только входящие транзакции
                    order_by: "block_timestamp,desc",
                },
                "get"
            );

            if (!response.data || !Array.isArray(response.data)) {
                return;
            }

            for (const tx of response.data) {
                if (this.processedTxs.has(tx.txID)) continue;

                // Проверяем, что это входящая TRX транзакция с правильной суммой
                if (this.isValidTRXTransaction(tx, payment)) {
                    try {
                        await this.paymentService.handleCryptoPayment(tx.txID);
                        this.processedTxs.add(tx.txID);
                        console.log(`✅ Processed TRX payment: ${tx.txID}`);
                        break; // Выходим после первой найденной транзакции
                    } catch (error) {
                        console.error(
                            `Error processing TRX transaction ${tx.txID}:`,
                            error
                        );
                    }
                }
            }
        } catch (error) {
            console.error("Error checking TRX transactions:", error);
        }
    }

    private async checkUSDTTransactions(payment: any) {
        try {
            // Получаем TRC20 транзакции для USDT
            const response = await this.tronWeb.fullNode.request(
                "v1/accounts/" + payment.cryptoAddress + "/transactions/trc20",
                {
                    limit: 20,
                    contract_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", // USDT TRC20
                    only_to: true,
                    order_by: "block_timestamp,desc",
                },
                "get"
            );

            if (!response.data || !Array.isArray(response.data)) {
                return;
            }

            for (const tx of response.data) {
                if (this.processedTxs.has(tx.transaction_id)) continue;

                // Проверяем, что это входящая USDT транзакция с правильной суммой
                if (this.isValidUSDTTransaction(tx, payment)) {
                    try {
                        await this.paymentService.handleCryptoPayment(
                            tx.transaction_id
                        );
                        this.processedTxs.add(tx.transaction_id);
                        console.log(
                            `✅ Processed USDT payment: ${tx.transaction_id}`
                        );
                        break; // Выходим после первой найденной транзакции
                    } catch (error) {
                        console.error(
                            `Error processing USDT transaction ${tx.transaction_id}:`,
                            error
                        );
                    }
                }
            }
        } catch (error) {
            console.error("Error checking USDT transactions:", error);
        }
    }

    private isValidTRXTransaction(tx: any, payment: any): boolean {
        try {
            // Проверяем базовые поля
            if (!tx.raw_data?.contract?.[0]) return false;

            const contract = tx.raw_data.contract[0];

            // Проверяем тип контракта
            if (contract.type !== "TransferContract") return false;

            // Получаем адрес получателя и сумму
            const toAddress = this.tronWeb.address.fromHex(
                contract.parameter.value.to_address
            );
            const amount = contract.parameter.value.amount / 1000000; // Конвертируем в TRX

            // Проверяем время транзакции (должна быть после создания платежа)
            const txTimestamp = new Date(tx.block_timestamp);
            const paymentCreated = new Date(payment.createdAt);

            // Основные проверки
            const isCorrectAddress = toAddress === payment.cryptoAddress;
            const isCorrectAmount =
                Math.abs(amount - parseFloat(payment.expectedAmount)) < 0.01;
            const isAfterPaymentCreated = txTimestamp >= paymentCreated;

            console.log(`TRX Transaction validation:`, {
                txID: tx.txID,
                toAddress,
                expectedAddress: payment.cryptoAddress,
                amount,
                expectedAmount: parseFloat(payment.expectedAmount),
                isCorrectAddress,
                isCorrectAmount,
                isAfterPaymentCreated,
                txTimestamp: txTimestamp.toISOString(),
                paymentCreated: paymentCreated.toISOString(),
            });

            return isCorrectAddress && isCorrectAmount && isAfterPaymentCreated;
        } catch (error) {
            console.error("Error validating TRX transaction:", error);
            return false;
        }
    }

    private isValidUSDTTransaction(tx: any, payment: any): boolean {
        try {
            // Для TRC20 транзакций структура немного другая
            const toAddress = tx.to;
            const fromAddress = tx.from;

            // Сумма уже в правильном формате (USDT)
            const amount =
                parseFloat(tx.value) / Math.pow(10, tx.token_info.decimals);

            // Проверяем время транзакции
            const txTimestamp = new Date(tx.block_timestamp);
            const paymentCreated = new Date(payment.createdAt);

            // Проверяем статус транзакции
            const isSuccess = tx.type === "Transfer" && tx.result === "SUCCESS";

            // Основные проверки
            const isCorrectAddress = toAddress === payment.cryptoAddress;
            const isCorrectAmount =
                Math.abs(amount - parseFloat(payment.expectedAmount)) < 0.01;
            const isAfterPaymentCreated = txTimestamp >= paymentCreated;

            console.log(`USDT Transaction validation:`, {
                txID: tx.transaction_id,
                toAddress,
                fromAddress,
                expectedAddress: payment.cryptoAddress,
                amount,
                expectedAmount: parseFloat(payment.expectedAmount),
                decimals: tx.token_info.decimals,
                isCorrectAddress,
                isCorrectAmount,
                isAfterPaymentCreated,
                isSuccess,
                txTimestamp: txTimestamp.toISOString(),
                paymentCreated: paymentCreated.toISOString(),
            });

            return (
                isCorrectAddress &&
                isCorrectAmount &&
                isAfterPaymentCreated &&
                isSuccess
            );
        } catch (error) {
            console.error("Error validating USDT transaction:", error);
            return false;
        }
    }

    // Очистка кэша обработанных транзакций (вызывать периодически)
    clearProcessedCache() {
        if (this.processedTxs.size > 1000) {
            this.processedTxs.clear();
            console.log("🧹 Cleared processed transactions cache");
        }
    }
}
