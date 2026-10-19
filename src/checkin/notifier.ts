// ============================================================================
// 1min-bridge — Check-in Notification Dispatcher
// ============================================================================

import type { CheckinConfig, CheckinResult } from "../types.js";

/**
 * Formats a message summarizing the check-in outcome.
 */
export function formatCheckinMessage(result: CheckinResult): { text: string; markdown: string } {
  const timestamp = result.timestamp;
  if (result.success) {
    const diffStr =
      result.creditDiff !== undefined && result.creditDiff > 0
        ? ` (+${result.creditDiff.toLocaleString()} credits reward! 🎉)`
        : result.creditDiff === 0
          ? " (Already checked in today / no bonus delta)"
          : "";

    const balanceStr =
      result.finalCredit !== undefined ? result.finalCredit.toLocaleString() : "Unknown";
    const percentStr = result.availablePercent ? ` [${result.availablePercent}% available]` : "";
    const userStr = result.userName || "1min.ai User";

    const text = `✅ 1min.ai Daily Check-in Succeeded!\nUser: ${userStr}\nBalance: ${balanceStr}${diffStr}${percentStr}\nTime: ${timestamp}`;

    const markdown =
      `*✅ 1min.ai Daily Check-in Succeeded!*\n\n` +
      `*User:* \`${userStr}\`\n` +
      `*Balance:* \`${balanceStr}\`${percentStr}\n` +
      (result.creditDiff && result.creditDiff > 0
        ? `*Reward:* \`+${result.creditDiff.toLocaleString()}\` credits 🎉\n`
        : "") +
      `*Time:* \`${timestamp}\``;

    return { text, markdown };
  } else {
    const errorStr = result.error || "Unknown error";
    const text = `❌ 1min.ai Daily Check-in Failed!\nError: ${errorStr}\nTime: ${timestamp}`;
    const markdown =
      `*❌ 1min.ai Daily Check-in Failed!*\n\n` +
      `*Error:* \`${errorStr}\`\n` +
      `*Time:* \`${timestamp}\``;

    return { text, markdown };
  }
}

/**
 * Sends a notification via Telegram Bot API.
 */
async function sendTelegramNotification(
  token: string,
  chatId: string,
  result: CheckinResult,
): Promise<void> {
  const { markdown } = formatCheckinMessage(result);
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const body = {
    chat_id: chatId,
    text: markdown,
    parse_mode: "Markdown",
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Telegram API responded with ${response.status}: ${errorText}`);
  }
}

/**
 * Sends a notification to a generic / Discord / Slack webhook.
 */
async function sendGenericWebhookNotification(
  webhookUrl: string,
  result: CheckinResult,
): Promise<void> {
  const { text, markdown } = formatCheckinMessage(result);

  // Payload structure compatible with Slack, Discord, and custom webhooks
  const payload = {
    text,
    content: markdown,
    embeds: [
      {
        title: result.success ? "1min.ai Check-in Succeeded" : "1min.ai Check-in Failed",
        color: result.success ? 0x22c55e : 0xef4444, // Green vs Red
        fields: [
          ...(result.userName ? [{ name: "User", value: result.userName, inline: true }] : []),
          ...(result.finalCredit !== undefined
            ? [{ name: "Balance", value: result.finalCredit.toLocaleString(), inline: true }]
            : []),
          ...(result.creditDiff !== undefined && result.creditDiff > 0
            ? [{ name: "Reward", value: `+${result.creditDiff.toLocaleString()}`, inline: true }]
            : []),
          ...(result.error ? [{ name: "Error", value: result.error, inline: false }] : []),
        ],
        timestamp: new Date().toISOString(),
      },
    ],
    checkin: result,
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Webhook responded with ${response.status}: ${errorText}`);
  }
}

/**
 * Dispatches notifications according to the provided check-in configuration.
 */
export async function dispatchCheckinNotification(
  config: CheckinConfig,
  result: CheckinResult,
): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (config.telegramBotToken && config.telegramChatId) {
    tasks.push(
      sendTelegramNotification(config.telegramBotToken, config.telegramChatId, result).catch(
        (err) => {
          console.warn("[Check-in Notification] Telegram dispatch error:", (err as Error).message);
        },
      ),
    );
  }

  if (config.webhookUrl) {
    tasks.push(
      sendGenericWebhookNotification(config.webhookUrl, result).catch((err) => {
        console.warn("[Check-in Notification] Webhook dispatch error:", (err as Error).message);
      }),
    );
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

/** Sends a plain-text alert (e.g. low credits) to Telegram and/or the webhook. */
export async function dispatchTextAlert(config: CheckinConfig, text: string): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (config.telegramBotToken && config.telegramChatId) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.telegramChatId, text }),
      }).catch((err) => console.warn("[Alert] Telegram error:", (err as Error).message)),
    );
  }
  if (config.webhookUrl) {
    tasks.push(
      fetch(config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, content: text }),
      }).catch((err) => console.warn("[Alert] Webhook error:", (err as Error).message)),
    );
  }
  await Promise.allSettled(tasks);
}
