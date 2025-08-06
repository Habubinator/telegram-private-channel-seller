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
            {
                command: "check",
                description: "Проверить статус платежа",
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
                        "✅ Добро пожаловать! Ваша подписка активна, доступ к каналу предоставлен."
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
                                    text: "📅 На сутки",
                                    callback_data: "plan_DAY",
                                },
                            ],
                            [
                                {
                                    text: "📅 На неделю",
                                    callback_data: "plan_WEEK",
                                },
                            ],
                            [
                                {
                                    text: "📅 На месяц",
                                    callback_data: "plan_MONTH",
                                },
                            ],
                        ],
                    };

                    await this.bot.sendMessage(
                        userId,
                        "❌ Для доступа к каналу необходима подписка.\n\nВыберите тариф:",
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

                // Генерируем одноразовую ссылку-приглашение
                const inviteLink = await this.createInviteLink();

                const keyboard = {
                    inline_keyboard: [
                        [
                            {
                                text: "🔗 Войти в канал",
                                url: inviteLink,
                            },
                        ],
                    ],
                };

                await this.bot.sendMessage(
                    msg.chat.id,
                    "✅ Платеж успешно обработан! Вы получили доступ к каналу.",
                    { reply_markup: keyboard }
                );
            } catch (error) {
                console.error("Payment processing error:", error);
                await this.bot.sendMessage(
                    msg.chat.id,
                    "❌ Ошибка при обработке платежа. Обратитесь в поддержку."
                );
            }
        });

        // Обработка команды /start
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
                        "❌ У вас нет ожидающих крипто-платежей для проверки."
                    );
                    return;
                }

                await this.bot.sendMessage(
                    msg.chat.id,
                    "🔄 Проверяю статус платежа..."
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
                                    text: "🔗 Войти в канал",
                                    url: inviteLink,
                                },
                            ],
                        ],
                    };

                    await this.bot.sendMessage(
                        msg.chat.id,
                        "✅ Платеж подтвержден! Подписка активирована.",
                        { reply_markup: keyboard }
                    );
                } else if (
                    ["failed", "refunded", "expired"].includes(
                        result.nowPayment.payment_status
                    )
                ) {
                    await this.bot.sendMessage(
                        msg.chat.id,
                        "❌ Платеж не прошел. Попробуйте создать новый платеж."
                    );
                } else {
                    // Платеж еще обрабатывается
                    const statusText = this.getPaymentStatusText(
                        result.nowPayment.payment_status
                    );
                    await this.bot.sendMessage(
                        msg.chat.id,
                        `⏳ Статус платежа: ${statusText}\n\nПовторите команду /check через несколько минут.`
                    );
                }
            } catch (error) {
                console.error("Error checking payment:", error);
                await this.bot.sendMessage(
                    msg.chat.id,
                    "❌ Ошибка при проверке платежа. Попробуйте позже."
                );
            }
        });

        // Обработка возврата к выбору тарифов
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
                                    text: "🔄 Проверить платеж",
                                    callback_data: `check_payment_${result.paymentId}`,
                                },
                            ],
                            [
                                {
                                    text: "ℹ️ Инструкция по оплате",
                                    callback_data: `payment_info_${result.paymentId}`,
                                },
                            ],
                        ],
                    };

                    const message = `
💳 **Крипто-платеж USDT TRC20**

💰 **Сумма:** \`${result.amount}\` USDT
📍 **Адрес:** \`${result.address}\`
🆔 **ID платежа:** \`${result.paymentId}\`

⏰ **Время на оплату:** 60 минут
⚠️ **Важно:** Отправьте точную сумму на указанный адрес

После отправки используйте команду /check или нажмите кнопку "Проверить платеж"
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

        // Обработка проверки конкретного платежа
        this.bot.on("callback_query", async (query) => {
            if (!query.data?.startsWith("check_payment_")) return;

            const paymentId = query.data.split("check_payment_")[1];

            try {
                await this.bot.answerCallbackQuery(query.id, {
                    text: "🔄 Проверяю платеж...",
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
                                    text: "🔗 Войти в канал",
                                    url: inviteLink,
                                },
                            ],
                        ],
                    };

                    await this.bot.editMessageText(
                        "✅ Платеж подтвержден! Подписка активирована.",
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
                        "❌ Платеж не прошел. Попробуйте создать новый платеж командой /start",
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
                                    text: "🔄 Проверить еще раз",
                                    callback_data: `check_payment_${paymentId}`,
                                },
                            ],
                        ],
                    };

                    await this.bot.editMessageText(
                        `⏳ Статус платежа: ${statusText}\n\nПопробуйте проверить через несколько минут.`,
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
                    text: "❌ Ошибка при проверке платежа",
                    show_alert: true,
                });
            }
        });

        // Обработка информации о платеже
        this.bot.on("callback_query", async (query) => {
            if (!query.data?.startsWith("payment_info_")) return;

            const infoText = `
📋 **Инструкция по оплате USDT TRC20:**

1️⃣ Откройте ваш крипто-кошелек
2️⃣ Выберите отправку USDT в сети TRON (TRC20)
3️⃣ Скопируйте адрес получателя из сообщения выше
4️⃣ Введите точную сумму (очень важно!)
5️⃣ Отправьте транзакцию
6️⃣ Используйте команду /check для проверки

⚠️ **Важные моменты:**
• Используйте только сеть TRON (TRC20)
• Отправьте точную сумму
• Комиссия сети оплачивается отдельно
• Платеж действителен 60 минут

❓ **Популярные кошельки с поддержкой TRC20:**
• TronLink, Trust Wallet, Atomic Wallet
• Биржи: Binance, Huobi, OKEx
            `;

            await this.bot.answerCallbackQuery(query.id, {
                text: "Инструкция отправлена!",
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
                            text: "🔗 Войти в канал",
                            url: inviteLink,
                        },
                    ],
                ],
            };

            await this.bot.sendMessage(
                Number(user.telegramId),
                "✅ Платеж успешно обработан! Вы получили доступ к каналу.",
                { reply_markup: keyboard }
            );
        } catch (error) {
            console.error("Error handling crypto payment success:", error);
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

    private getPaymentStatusText(status: string): string {
        const statusMap: { [key: string]: string } = {
            waiting: "Ожидает оплаты",
            confirming: "Подтверждается в блокчейне",
            confirmed: "Подтверждено, обрабатывается",
            sending: "Отправляется",
            partially_paid: "Частично оплачено",
            finished: "Завершено",
            failed: "Неудачно",
            refunded: "Возвращено",
            expired: "Истекло",
        };

        return statusMap[status] || status;
    }
}
