import TelegramBot from "node-telegram-bot-api";
import { PaymentService } from "../services/PaymentService";
import { PrismaClient, PlanType } from "@prisma/client";

export class PaymentHandlers {
    constructor(
        private bot: TelegramBot,
        private paymentService: PaymentService,
        private prisma: PrismaClient
    ) {
        this.setupHandlers();
    }

    private setupHandlers() {
        this.bot.setMyCommands([
            {
                command: "start",
                description: "Подписаться на канал",
            },
        ]);

        // Обработка pre_checkout_query (звезды)
        this.bot.on("pre_checkout_query", async (query) => {
            try {
                // Проверяем валидность платежа
                const payment = await this.prisma.payment.findUnique({
                    where: { invoicePayload: query.invoice_payload },
                });

                if (!payment || payment.expiresAt < new Date()) {
                    await this.bot.answerPreCheckoutQuery(query.id, false, {
                        error_message: "Платеж истек или не найден",
                    });
                    return;
                }

                await this.bot.answerPreCheckoutQuery(query.id, true);
            } catch (error) {
                console.error("Pre-checkout error:", error);
                await this.bot.answerPreCheckoutQuery(query.id, false, {
                    error_message: "Ошибка обработки платежа",
                });
            }
        });

        // Обработка успешного платежа звездами
        this.bot.on("successful_payment", async (msg) => {
            try {
                const payment = msg.successful_payment!;

                await this.paymentService.handleTelegramStarsSuccess(
                    payment.invoice_payload,
                    payment.telegram_payment_charge_id
                );

                await this.bot.sendMessage(
                    msg.chat.id,
                    "✅ Платеж успешно обработан! Вы получили доступ к каналу."
                );

                // Добавляем пользователя в канал
                await this.addUserToChannel(msg.from!.id);
            } catch (error) {
                console.error("Payment processing error:", error);
                await this.bot.sendMessage(
                    msg.chat.id,
                    "❌ Ошибка при обработке платежа. Обратитесь в поддержку."
                );
            }
        });

        // Обработка команд выбора тарифа
        this.bot.onText(/\/start/, async (msg) => {
            const keyboard = {
                inline_keyboard: [
                    [{ text: "📅 На сутки", callback_data: "plan_DAY" }],
                    [{ text: "📅 На неделю", callback_data: "plan_WEEK" }],
                    [{ text: "📅 На месяц", callback_data: "plan_MONTH" }],
                ],
            };

            await this.bot.sendMessage(
                msg.chat.id,
                "Выберите тариф подписки:",
                { reply_markup: keyboard }
            );
        });

        // Обработка назад
        this.bot.on("callback_query", async (query) => {
            if (!query.data?.startsWith("back_to_plans")) return;

            const keyboard = {
                inline_keyboard: [
                    [{ text: "📅 На сутки", callback_data: "plan_DAY" }],
                    [{ text: "📅 На неделю", callback_data: "plan_WEEK" }],
                    [{ text: "📅 На месяц", callback_data: "plan_MONTH" }],
                ],
            };

            await this.bot.editMessageText(`Выберите тариф подписки:`, {
                chat_id: query.message!.chat.id,
                message_id: query.message!.message_id,
                reply_markup: keyboard,
            });
        });

        // Обработка выбора тарифа
        this.bot.on("callback_query", async (query) => {
            if (!query.data?.startsWith("plan_")) return;

            const planType = query.data.split("_")[1] as PlanType;
            const userId = await this.getOrCreateUser(query.from);

            const keyboard = {
                inline_keyboard: [
                    [
                        {
                            text: "⭐ Оплатить звездами",
                            callback_data: `pay_stars_${planType}`,
                        },
                    ],
                    [
                        {
                            text: "💵 Оплатить USDT",
                            callback_data: `pay_usdt_${planType}`,
                        },
                    ],
                    [{ text: "← Назад", callback_data: "back_to_plans" }],
                ],
            };

            await this.bot.editMessageText(
                `Выбран тариф: ${this.getPlanName(
                    planType
                )}\nВыберите способ оплаты:`,
                {
                    chat_id: query.message!.chat.id,
                    message_id: query.message!.message_id,
                    reply_markup: keyboard,
                }
            );
        });

        // Обработка выбора способа оплаты
        this.bot.on("callback_query", async (query) => {
            if (!query.data?.startsWith("pay_")) return;
            const [, paymentType, planType] = query.data.split("_");
            const userId = await this.getOrCreateUser(query.from);

            try {
                if (paymentType === "stars") {
                    await this.paymentService.createTelegramStarsPayment(
                        userId,
                        query.from.id,
                        planType as PlanType
                    );

                    await this.bot.answerCallbackQuery(query.id, {
                        text: "Инвойс отправлен! Проверьте сообщения.",
                    });
                } else {
                    const { payment, address } =
                        await this.paymentService.createCryptoPayment(
                            userId,
                            planType as PlanType,
                            paymentType.toUpperCase() as "TRX" | "USDT"
                        );

                    const message = `
💳 Крипто-платеж ${paymentType.toUpperCase()}

📋 **Данные для оплаты:**
💰 Сумма: ${payment.amount} ${payment.currency}
📍 Адрес: \`${address}\`
🆔 ID платежа: \`${payment.id}\`

⏰ Время на оплату: 60 минут
⚠️ Отправьте точную сумму на указанный адрес

После оплаты подписка активируется автоматически.
          `;

                    await this.bot.sendMessage(
                        query.message!.chat.id,
                        message,
                        {
                            parse_mode: "Markdown",
                        }
                    );

                    await this.bot.answerCallbackQuery(query.id, {
                        text: "Реквизиты для оплаты отправлены!",
                    });
                }
            } catch (error) {
                console.error("Payment creation error:", error);
                await this.bot.answerCallbackQuery(query.id, {
                    text: "Ошибка создания платежа. Попробуйте позже.",
                    show_alert: true,
                });
            }
        });
    }

    private async getOrCreateUser(
        telegramUser: TelegramBot.User
    ): Promise<string> {
        let user = await this.prisma.user.findUnique({
            where: { telegramId: BigInt(telegramUser.id) },
        });

        if (!user) {
            user = await this.prisma.user.create({
                data: {
                    telegramId: BigInt(telegramUser.id),
                    username: telegramUser.username,
                    firstName: telegramUser.first_name,
                    lastName: telegramUser.last_name,
                },
            });
        }

        return user.id;
    }

    private async addUserToChannel(telegramId: number) {
        try {
            await this.bot.unbanChatMember(process.env.CHANNEL_ID!, telegramId);
        } catch (error) {
            console.error("Error adding user to channel:", error);
        }
    }

    private getPlanName(planType: PlanType): string {
        const names = {
            [PlanType.DAY]: "сутки",
            [PlanType.WEEK]: "неделю",
            [PlanType.MONTH]: "месяц",
        };
        return names[planType];
    }
}
