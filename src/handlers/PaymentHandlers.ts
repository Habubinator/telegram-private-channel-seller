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
                description: "Subscribe to the channel",
            },
            {
                command: "check",
                description: "Check payment status",
            },
        ]);

        // Обработка запроса на вступление в группу/канал
        this.bot.on("chat_join_request", async (chatJoinRequest) => {
            try {
                const userId = chatJoinRequest.from.id;
                const chatId = chatJoinRequest.chat.id;

                console.log(
                    `Join request from user ${userId} to chat ${chatId}`
                );

                // Проверяем, есть ли у пользователя активная подписка
                const user = await this.prisma.user.findUnique({
                    where: { telegramId: BigInt(userId) },
                    include: {
                        subscriptions: {
                            where: {
                                channelId: chatId.toString(),
                                isActive: true,
                                endDate: { gte: new Date() },
                            },
                        },
                    },
                });

                if (user && user.subscriptions.length > 0) {
                    // У пользователя есть активная подписка - одобряем запрос
                    await this.bot.approveChatJoinRequest(chatId, userId);

                    // Отправляем уведомление пользователю
                    await this.bot.sendMessage(
                        userId,
                        "✅ Welcome! Your subscription is active, access to the channel has been granted."
                    );

                    console.log(
                        `Approved join request for user ${userId} with active subscription`
                    );
                } else {
                    // У пользователя нет активной подписки - отклоняем и предлагаем оплатить
                    await this.bot.declineChatJoinRequest(chatId, userId);

                    // Создаем или обновляем пользователя
                    await this.getOrCreateUser(chatJoinRequest.from);

                    // Предлагаем выбрать тариф
                    const keyboard = {
                        inline_keyboard: [
                            [
                                {
                                    text: "📅 For a day",
                                    callback_data: "plan_DAY",
                                },
                            ],
                            [
                                {
                                    text: "📅 For a week",
                                    callback_data: "plan_WEEK",
                                },
                            ],
                            [
                                {
                                    text: "📅 For a month",
                                    callback_data: "plan_MONTH",
                                },
                            ],
                        ],
                    };

                    await this.bot.sendMessage(
                        userId,
                        "❌ A subscription is required to access the channel.\n\nSelect a plan:",
                        { reply_markup: keyboard }
                    );

                    console.log(
                        `Declined join request for user ${userId} - no active subscription`
                    );
                }
            } catch (error) {
                console.error("Error handling chat join request:", error);

                // В случае ошибки отклоняем запрос
                try {
                    await this.bot.declineChatJoinRequest(
                        chatJoinRequest.chat.id,
                        chatJoinRequest.from.id
                    );
                } catch (declineError) {
                    console.error(
                        "Error declining join request:",
                        declineError
                    );
                }
            }
        });

        // Обработка pre_checkout_query (звезды)
        this.bot.on("pre_checkout_query", async (query) => {
            try {
                const payment = await this.prisma.payment.findUnique({
                    where: { invoicePayload: query.invoice_payload },
                });

                if (!payment || payment.expiresAt < new Date()) {
                    await this.bot.answerPreCheckoutQuery(query.id, false, {
                        error_message: "Payment expired or not found",
                    });
                    return;
                }

                await this.bot.answerPreCheckoutQuery(query.id, true);
            } catch (error) {
                console.error("Pre-checkout error:", error);
                await this.bot.answerPreCheckoutQuery(query.id, false, {
                    error_message: "Payment error.",
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

                // Генерируем одноразовую ссылку-приглашение
                const inviteLink = await this.createInviteLink();

                const keyboard = {
                    inline_keyboard: [
                        [
                            {
                                text: "🔗 Join Channel",
                                url: inviteLink,
                            },
                        ],
                    ],
                };

                await this.bot.sendMessage(
                    msg.chat.id,
                    "✅ Payment successfully processed! You have gained access to the channel.",
                    { reply_markup: keyboard }
                );
            } catch (error) {
                console.error("Payment processing error:", error);
                await this.bot.sendMessage(
                    msg.chat.id,
                    "❌ Error processing payment. Please contact owner for help."
                );
            }
        });

        // Обработка команды /start
        this.bot.onText(/\/start/, async (msg) => {
            const keyboard = {
                inline_keyboard: [
                    [{ text: "📅 For a day", callback_data: "plan_DAY" }],
                    [{ text: "📅 For a week", callback_data: "plan_WEEK" }],
                    [{ text: "📅 For a month", callback_data: "plan_MONTH" }],
                ],
            };

            await this.bot.sendMessage(
                msg.chat.id,
                "Select a subscription plan:",
                { reply_markup: keyboard }
            );
        });

        // Обработка команды /check для проверки крипто-платежа
        this.bot.onText(/\/check/, async (msg) => {
            try {
                const userId = await this.getOrCreateUser(msg.from!);

                // Ищем последний pending крипто-платеж пользователя
                const pendingPayment = await this.prisma.payment.findFirst({
                    where: {
                        userId: userId,
                        status: "PENDING",
                        paymentType: "CRYPTO_USDT",
                    },
                    orderBy: {
                        createdAt: "desc",
                    },
                });

                if (!pendingPayment || !pendingPayment.cryptoTxHash) {
                    await this.bot.sendMessage(
                        msg.chat.id,
                        "❌ You have no pending crypto payments to verify."
                    );
                    return;
                }

                await this.bot.sendMessage(
                    msg.chat.id,
                    "🔄 Checking payment status..."
                );

                const result =
                    await this.paymentService.checkCryptoPaymentStatus(
                        pendingPayment.cryptoTxHash
                    );

                if (
                    result.statusChanged &&
                    result.nowPayment.payment_status === "finished"
                ) {
                    // Платеж успешен
                    const inviteLink = await this.createInviteLink();
                    const keyboard = {
                        inline_keyboard: [
                            [
                                {
                                    text: "🔗 Join channel",
                                    url: inviteLink,
                                },
                            ],
                        ],
                    };

                    await this.bot.sendMessage(
                        msg.chat.id,
                        "✅ Payment confirmed! Subscription activated.",
                        { reply_markup: keyboard }
                    );
                } else if (
                    ["failed", "refunded", "expired"].includes(
                        result.nowPayment.payment_status
                    )
                ) {
                    await this.bot.sendMessage(
                        msg.chat.id,
                        "❌ Payment failed. Try creating a new payment."
                    );
                } else {
                    // Платеж еще обрабатывается
                    const statusText = this.getPaymentStatusText(
                        result.nowPayment.payment_status
                    );
                    await this.bot.sendMessage(
                        msg.chat.id,
                        `⏳ Payment status: ${statusText}\n\nPlease repeat the /check command in a few minutes.`
                    );
                }
            } catch (error) {
                console.error("Error checking payment:", error);
                await this.bot.sendMessage(
                    msg.chat.id,
                    "❌ Error checking payment. Please try again later."
                );
            }
        });

        // Обработка возврата к выбору тарифов
        this.bot.on("callback_query", async (query) => {
            if (!query.data?.startsWith("back_to_plans")) return;

            const keyboard = {
                inline_keyboard: [
                    [{ text: "📅 For a day", callback_data: "plan_DAY" }],
                    [{ text: "📅 For a week", callback_data: "plan_WEEK" }],
                    [{ text: "📅 For a month", callback_data: "plan_MONTH" }],
                ],
            };

            await this.bot.editMessageText(`Select a subscription plan:`, {
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
                            text: "⭐ Pay with TGStars (no comission)",
                            callback_data: `pay_stars_${planType}`,
                        },
                    ],
                    [
                        {
                            text: "💵 Pay with USDT",
                            callback_data: `pay_usdt_${planType}`,
                        },
                    ],
                    [{ text: "← Back", callback_data: "back_to_plans" }],
                ],
            };

            await this.bot.editMessageText(
                `Selected tariff: ${this.getPlanName(
                    planType
                )}\nSelect a payment method:`,
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
                        text: "The invoice has been sent! Please check your messages.",
                    });
                } else if (paymentType === "usdt") {
                    const result =
                        await this.paymentService.createCryptoPayment(
                            userId,
                            planType as PlanType
                        );

                    const keyboard = {
                        inline_keyboard: [
                            [
                                {
                                    text: "🔄 Check payment",
                                    callback_data: `check_payment_${result.paymentId}`,
                                },
                            ],
                            [
                                {
                                    text: "ℹ️ Payment instructions",
                                    callback_data: `payment_info_${result.paymentId}`,
                                },
                            ],
                        ],
                    };

                    const message = `
💳 **USDT TRC20 crypto payment**

💰 **Amount:** \`${result.amount}\` USDT
📍 **Address:** \`${result.address}\`
🆔 **Payment ID:** \`${result.paymentId}\`

⏰ **Payment time:** 60 minutes
⚠️ **Important:** Send the exact amount to the specified address
⚠️ **Important:** Transfer fees are included in the price

After sending, use the /check command or click the “Check payment” button
                    `;

                    await this.bot.sendMessage(
                        query.message!.chat.id,
                        message,
                        {
                            parse_mode: "Markdown",
                            reply_markup: keyboard,
                        }
                    );

                    await this.bot.answerCallbackQuery(query.id, {
                        text: "Payment details have been sent!",
                    });
                }
            } catch (error) {
                console.error("Payment creation error:", error);
                await this.bot.answerCallbackQuery(query.id, {
                    text: "Error creating payment. Please try again later.",
                    show_alert: true,
                });
            }
        });

        // Обработка проверки конкретного платежа
        this.bot.on("callback_query", async (query) => {
            if (!query.data?.startsWith("check_payment_")) return;

            const paymentId = query.data.split("check_payment_")[1];

            try {
                await this.bot.answerCallbackQuery(query.id, {
                    text: "🔄 Checking payment...",
                });

                const result =
                    await this.paymentService.checkCryptoPaymentStatus(
                        paymentId
                    );

                if (
                    result.statusChanged &&
                    result.nowPayment.payment_status === "finished"
                ) {
                    // Платеж успешен
                    const inviteLink = await this.createInviteLink();
                    const keyboard = {
                        inline_keyboard: [
                            [
                                {
                                    text: "🔗 Join channel",
                                    url: inviteLink,
                                },
                            ],
                        ],
                    };

                    await this.bot.editMessageText(
                        "✅ Payment confirmed! Subscription activated.",
                        {
                            chat_id: query.message!.chat.id,
                            message_id: query.message!.message_id,
                            reply_markup: keyboard,
                        }
                    );
                } else if (
                    ["failed", "refunded", "expired"].includes(
                        result.nowPayment.payment_status
                    )
                ) {
                    await this.bot.editMessageText(
                        "❌ Payment failed. Try creating a new payment with the command /start.",
                        {
                            chat_id: query.message!.chat.id,
                            message_id: query.message!.message_id,
                        }
                    );
                } else {
                    // Платеж еще обрабатывается
                    const statusText = this.getPaymentStatusText(
                        result.nowPayment.payment_status
                    );

                    const keyboard = {
                        inline_keyboard: [
                            [
                                {
                                    text: "🔄 Check again",
                                    callback_data: `check_payment_${paymentId}`,
                                },
                            ],
                        ],
                    };

                    await this.bot.editMessageText(
                        `⏳ Payment status: ${statusText}\n\nPlease try again in a few minutes.`,
                        {
                            chat_id: query.message!.chat.id,
                            message_id: query.message!.message_id,
                            reply_markup: keyboard,
                        }
                    );
                }
            } catch (error) {
                console.error("Error checking payment:", error);
                await this.bot.answerCallbackQuery(query.id, {
                    text: "❌ Error checking payment",
                    show_alert: true,
                });
            }
        });

        // Обработка информации о платеже
        this.bot.on("callback_query", async (query) => {
            if (!query.data?.startsWith("payment_info_")) return;

            const infoText = `
📋 **Instructions for paying with USDT TRC20:**

1️⃣ Open your crypto wallet
2️⃣ Select to send USDT on the TRON network (TRC20)
3️⃣ Copy the recipient's address from the message above
4️⃣ Enter the exact amount (very important!)
5️⃣ Send the transaction
6️⃣ Use the /check command or button to verify

⚠️ **Important points:**
• Use only the TRON (TRC20) network
• Send the exact amount
• Network fees (10.5 USD) are paid separately
• The payment is valid for 60 minutes
            `;

            await this.bot.answerCallbackQuery(query.id, {
                text: "Instruction sent!",
            });

            await this.bot.sendMessage(query.message!.chat.id, infoText, {
                parse_mode: "Markdown",
            });
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

    private async createInviteLink(): Promise<string> {
        try {
            // Создаем одноразовую ссылку-приглашение
            const inviteLink = await this.bot.createChatInviteLink(
                process.env.CHANNEL_ID!,
                {
                    name: `Invite_${Date.now()}`,
                    expire_date: Math.floor(Date.now() / 1000) + 60 * 100,
                    member_limit: 1, // Только для одного пользователя
                    creates_join_request: false, // Прямое добавление без запроса
                }
            );

            return inviteLink.invite_link;
        } catch (error) {
            console.error("Error creating invite link:", error);
            throw new Error("Failed to create invite link");
        }
    }

    // Метод для обработки успешных крипто-платежей
    async handleCryptoPaymentSuccess(userId: string) {
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
            });

            if (!user) {
                console.error(`User not found: ${userId}`);
                return;
            }

            // Генерируем одноразовую ссылку-приглашение
            const inviteLink = await this.createInviteLink();

            const keyboard = {
                inline_keyboard: [
                    [
                        {
                            text: "🔗 Join channel",
                            url: inviteLink,
                        },
                    ],
                ],
            };

            await this.bot.sendMessage(
                Number(user.telegramId),
                "✅ Your payment has been successfully processed! You now have access to the channel.",
                { reply_markup: keyboard }
            );
        } catch (error) {
            console.error("Error handling crypto payment success:", error);
        }
    }

    private getPlanName(planType: PlanType): string {
        const names = {
            [PlanType.DAY]: "day",
            [PlanType.WEEK]: "week",
            [PlanType.MONTH]: "month",
        };
        return names[planType];
    }

    private getPaymentStatusText(status: string): string {
        const statusMap: { [key: string]: string } = {
            waiting: "Waiting",
            confirming: "Confirming",
            confirmed: "Confirmed, proceeding",
            sending: "Sending",
            partially_paid: "Partially paid",
            finished: "Finished",
            failed: "Failed",
            refunded: "Refunded",
            expired: "Expired",
        };

        return statusMap[status] || status;
    }
}
