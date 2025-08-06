import axios, { AxiosInstance } from "axios";

export interface NOWPayment {
    payment_id: string;
    payment_status:
        | "waiting"
        | "confirming"
        | "confirmed"
        | "sending"
        | "partially_paid"
        | "finished"
        | "failed"
        | "refunded"
        | "expired";
    pay_address: string;
    price_amount: number;
    price_currency: string;
    pay_amount: number;
    pay_currency: string;
    order_id: string;
    order_description: string;
    purchase_id: string;
    created_at: string;
    updated_at: string;
    outcome_amount?: number;
    outcome_currency?: string;
}

export interface CreatePaymentRequest {
    price_amount: number;
    price_currency: string;
    pay_currency: string;
    order_id: string;
    order_description: string;
    // purchase_id убираем - используется только для доплат
}

export class NOWPaymentsService {
    private api: AxiosInstance;

    constructor(apiKey: string) {
        this.api = axios.create({
            baseURL: "https://api.nowpayments.io/v1",
            headers: {
                "x-api-key": apiKey,
                "Content-Type": "application/json",
            },
        });
    }

    /**
     * Создание крипто-платежа
     */
    async createPayment(data: CreatePaymentRequest): Promise<NOWPayment> {
        try {
            console.log("🔄 Creating NOWPayments payment with data:", {
                price_amount: data.price_amount,
                price_currency: data.price_currency,
                pay_currency: data.pay_currency,
                order_id: data.order_id,
                order_description:
                    data.order_description.substring(0, 30) + "...",
            });

            const response = await this.api.post("/payment", data);

            console.log("✅ NOWPayments payment created:", {
                payment_id: response.data.payment_id,
                status: response.data.payment_status,
                address: response.data.pay_address,
                amount: response.data.pay_amount,
                currency: response.data.pay_currency,
            });

            return response.data;
        } catch (error) {
            // Специальная обработка rate limit
            if (error.response?.status === 429) {
                console.error(
                    "❌ Rate limit exceeded, please wait before making another request"
                );
                throw new Error(
                    "Rate limit exceeded. Please try again in a few minutes."
                );
            }

            console.error("❌ Error creating NOWPayments payment:", {
                status: error.response?.status,
                statusCode: error.response?.data?.statusCode,
                code: error.response?.data?.code,
                message: error.response?.data?.message,
                requestData: {
                    price_amount: data.price_amount,
                    pay_currency: data.pay_currency,
                },
            });

            // Более информативная ошибка
            if (error.response?.data?.message) {
                throw new Error(
                    `NOWPayments API Error: ${error.response.data.message}`
                );
            }

            throw new Error("Failed to create crypto payment");
        }
    }

    /**
     * Получение статуса платежа
     */
    async getPaymentStatus(paymentId: string): Promise<NOWPayment> {
        try {
            const response = await this.api.get(`/payment/${paymentId}`);
            return response.data;
        } catch (error) {
            console.error(
                "Error getting payment status:",
                error.response?.data || error.message
            );
            throw new Error("Failed to get payment status");
        }
    }

    /**
     * Получение доступных валют
     */
    async getAvailableCurrencies(): Promise<string[]> {
        try {
            const response = await this.api.get("/currencies");
            return response.data.currencies;
        } catch (error) {
            console.error(
                "Error getting currencies:",
                error.response?.data || error.message
            );
            throw new Error("Failed to get available currencies");
        }
    }

    /**
     * Получение минимальной суммы для валюты
     */
    async getMinimumPaymentAmount(
        currencyFrom: string,
        currencyTo: string
    ): Promise<number> {
        try {
            const response = await this.api.get(
                `/min-amount?currency_from=${currencyFrom}&currency_to=${currencyTo}`
            );
            return response.data.min_amount;
        } catch (error) {
            console.error(
                "Error getting minimum amount:",
                error.response?.data || error.message
            );
            throw new Error("Failed to get minimum payment amount");
        }
    }

    /**
     * Проверка доступности API
     */
    async checkApiStatus(): Promise<boolean> {
        try {
            const response = await this.api.get("/status");
            return response.data.message === "OK";
        } catch (error) {
            console.error(
                "NOWPayments API is not available:",
                error.response?.data || error.message
            );
            return false;
        }
    }

    /**
     * Получение списка платежей
     */
    async getPayments(
        limit: number = 100,
        page: number = 0
    ): Promise<{ data: NOWPayment[] }> {
        try {
            const response = await this.api.get(
                `/payment/?limit=${limit}&page=${page}`
            );
            return response.data;
        } catch (error) {
            console.error(
                "Error getting payments list:",
                error.response?.data || error.message
            );
            throw new Error("Failed to get payments list");
        }
    }
}
