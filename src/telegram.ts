import axios from "axios";

export async function sendTelegramMessage(opts: {
  token: string;
  chatId: string;
  text: string;
}) {
  const url = `https://api.telegram.org/bot${opts.token}/sendMessage`;

  await axios.post(
    url,
    {
      chat_id: opts.chatId,
      text: opts.text,
      disable_web_page_preview: true,
    },
    { timeout: 15_000 }
  );
}
