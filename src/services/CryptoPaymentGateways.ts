import axios from "axios";
import crypto from "crypto";

export class NowPaymentsService {
    private apiKey: string;
    private apiUrl = "https://api.nowpayments.io/v1";

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    // Получаем доступные валюты
    async getAvailableCurrencies() {
        try {
            const response = await axios.get(`${this.apiUrl}/currencies`, {
                headers: { "x-api-key": this.apiKey },
            });
            return response.data.currencies;
        } catch (error) {
            console.error("Error getting currencies:", error);
            throw error;
        }
    }

    // Создаем платеж
    async createPayment(
        paymentId: string,
        amount: number,
        currency: string, // 'trx' или 'usdttrc20'
        orderDescription: string
    ) {
        try {
            const paymentData = {
                price_amount: amount,
                price_currency: "usd", // Базовая валюта
                pay_currency: currency.toLowerCase(),
                order_id: paymentId,
                order_description: orderDescription,
                ipn_callback_url: `${process.env.BASE_URL}/webhooks/nowpayments`, // Ваш webhook
                success_url: `${process.env.BASE_URL}/payment/success`,
                cancel_url: `${process.env.BASE_URL}/payment/cancel`,
            };

            const response = await axios.post(
                `${this.apiUrl}/payment`,
                paymentData,
                {
                    headers: {
                        "x-api-key": this.apiKey,
                        "Content-Type": "application/json",
                    },
                }
            );

            return {
                paymentId: response.data.payment_id,
                paymentUrl: response.data.invoice_url,
                payToAddress: response.data.pay_address,
                payAmount: response.data.pay_amount,
                currency: response.data.pay_currency,
            };
        } catch (error) {
            console.error("Error creating payment:", error);
            throw error;
        }
    }

    // Проверяем статус платежа
    async getPaymentStatus(paymentId: string) {
        try {
            const response = await axios.get(
                `${this.apiUrl}/payment/${paymentId}`,
                {
                    headers: { "x-api-key": this.apiKey },
                }
            );
            return response.data;
        } catch (error) {
            console.error("Error getting payment status:", error);
            throw error;
        }
    }

    // Обработка webhook
    verifyWebhook(signature: string, payload: string): boolean {
        const hmac = crypto.createHmac(
            "sha512",
            process.env.NOWPAYMENTS_IPN_SECRET!
        );
        hmac.update(payload);
        const expectedSignature = hmac.digest("hex");
        return signature === expectedSignature;
    }
}
