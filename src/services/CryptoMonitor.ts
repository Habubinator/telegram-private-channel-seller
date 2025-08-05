// services/CryptoMonitor.ts
import { PrismaClient, PaymentStatus, PaymentType } from "@prisma/client";
import TronWeb from "tronweb";
import { PaymentService } from "./PaymentService";

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
        const account = await this.tronWeb.trx.getAccount(
            payment.cryptoAddress
        );

        if (!account.address) return;

        // Получаем последние транзакции
        const transactions = await this.tronWeb.trx.getTransactionsFromAddress(
            payment.cryptoAddress,
            3, // Лимит
            0 // Смещение
        );

        for (const tx of transactions) {
            if (this.processedTxs.has(tx.txID)) continue;

            // Проверяем, что это входящая транзакция с правильной суммой
            if (this.isValidTRXTransaction(tx, payment)) {
                try {
                    await this.paymentService.handleCryptoPayment(tx.txID);
                    this.processedTxs.add(tx.txID);
                    console.log(`Processed TRX payment: ${tx.txID}`);
                } catch (error) {
                    console.error(
                        `Error processing TRX transaction ${tx.txID}:`,
                        error
                    );
                }
            }
        }
    }

    private async checkUSDTTransactions(payment: any) {
        try {
            // Для USDT нужно проверять TRC20 транзакции
            const contractAddress = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // USDT TRC20

            const transactions =
                await this.tronWeb.trx.getTransactionsFromAddress(
                    payment.cryptoAddress,
                    10,
                    0
                );

            for (const tx of transactions) {
                if (this.processedTxs.has(tx.txID)) continue;

                if (
                    await this.isValidUSDTTransaction(
                        tx,
                        payment,
                        contractAddress
                    )
                ) {
                    try {
                        await this.paymentService.handleCryptoPayment(tx.txID);
                        this.processedTxs.add(tx.txID);
                        console.log(`Processed USDT payment: ${tx.txID}`);
                    } catch (error) {
                        console.error(
                            `Error processing USDT transaction ${tx.txID}:`,
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
            if (!tx.raw_data?.contract?.[0]) return false;

            const contract = tx.raw_data.contract[0];
            if (contract.type !== "TransferContract") return false;

            const toAddress = this.tronWeb.address.fromHex(
                contract.parameter.value.to_address
            );
            const amount = contract.parameter.value.amount / 1000000; // Конвертируем в TRX

            return (
                toAddress === payment.cryptoAddress &&
                Math.abs(amount - parseFloat(payment.expectedAmount)) < 0.01 && // Допуск на комиссию
                new Date(tx.block_timestamp) >= new Date(payment.createdAt)
            );
        } catch (error) {
            return false;
        }
    }

    private isValidUSDTTransaction(
        tx: any,
        payment: any,
        contractAddress: string
    ): boolean {
        try {
            if (!tx.raw_data?.contract?.[0]) return false;

            const contract = tx.raw_data.contract[0];
            if (contract.type !== "TriggerSmartContract") return false;

            const contractAddr = this.tronWeb.address.fromHex(
                contract.parameter.value.contract_address
            );

            if (contractAddr !== contractAddress) return false;

            // Декодируем данные транзакции для получения суммы и получателя
            const data = contract.parameter.value.data;

            // Первые 8 символов - это селектор метода transfer (a9059cbb)
            if (!data.startsWith("a9059cbb")) return false;

            // Следующие 64 символа - адрес получателя
            const toAddressHex = data.slice(8, 72);
            const toAddress = this.tronWeb.address.fromHex(
                "41" + toAddressHex.slice(24)
            );

            // Следующие 64 символа - сумма в wei (1 USDT = 1000000 wei для TRC20)
            const amountHex = data.slice(72, 136);
            const amount = parseInt(amountHex, 16) / 1000000; // Конвертируем в USDT

            return (
                toAddress === payment.cryptoAddress &&
                Math.abs(amount - parseFloat(payment.expectedAmount)) < 0.01 &&
                new Date(tx.block_timestamp) >= new Date(payment.createdAt)
            );
        } catch (error) {
            return false;
        }
    }

    // Очистка кэша обработанных транзакций (вызывать периодически)
    clearProcessedCache() {
        if (this.processedTxs.size > 1000) {
            this.processedTxs.clear();
        }
    }
}
