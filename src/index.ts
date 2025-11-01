const DENYLIST = [
  "gguf",
  "gptq",
  "awq",
  "exl3",
  "exl2",
  "fp8",
  "mlx",
  "mxfp4",
  "nvfp4",
  "bnb-4bit",
  "bnb-8bit"
];

interface HFWebhookPayload {
  event: {
    action: string;
    scope: string;
  };
  repo: {
    type: string;
    name: string;
    id: string;
    private: boolean;
    url: {
      web: string;
      api: string;
    };
    owner: {
      id: string;
    };
    tags?: string[];
  };
  webhook: {
    id: string;
    version: number;
  };
}

interface Env {
  DISCORD_WEBHOOK_URL: string;
  HF_WEBHOOK_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Validate webhook secret if configured
    if (env.HF_WEBHOOK_SECRET) {
      const providedSecret = request.headers.get('X-Webhook-Secret');
      if (providedSecret !== env.HF_WEBHOOK_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    try {
      // Parse the HF webhook payload
      const payload: HFWebhookPayload = await request.json();

      // Only process repo create events
      if (payload.event.scope === 'repo' && payload.event.action === 'create') {
        await sendToDiscord(payload, env.DISCORD_WEBHOOK_URL);
      }

      // Always return 200 OK to HF
      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('Error processing webhook:', error);
      // Still return 200 to avoid HF retrying
      return new Response('OK', { status: 200 });
    }
  },
};

function abbreviateNumber(num, round = 'floor') {
  const units = ['K', 'M', 'B', 'T'];   // thousands, millions, billions, trillions
  let unitIndex = -1;                  // -1 means “no unit yet” (i.e. < 1000)
  let n = num;

  // Reduce the number until it fits into the next unit (or we run out of units)
  while (n >= 1000 && unitIndex < units.length - 1) {
    n /= 1000;      // divide by 10³ for each step
    unitIndex++;
  }

  // Apply the requested rounding mode
  const value = (round === 'round') ? Math.round(n) : Math.floor(n);

  // Return either just the integer or integer + unit
  return unitIndex >= 0 ? `${value}${units[unitIndex]}` : `${value}`;
}

function cleanMarkdown(md) {
  let s = md || "";

  // 1) Remove leading BOM and YAML frontmatter
  s = s.replace(/^\uFEFF?---\s*[\s\S]*?\n---\s*\n?/, "");

  // 2) Drop entire HTML block sections (keep none of their inner content)
  //    Useful for <details>, <div>, <table>, etc.
  s = s.replace(
    /<\s*(details|summary|div|table|thead|tbody|tr|td|th|style|script|footer|header|nav|section|aside|figure|figcaption)[\s\S]*?<\/\s*\1\s*>/gi,
    ""
  );

  // 3) Remove standalone/void HTML tags (img, br, hr, etc.)
  s = s.replace(/<\s*(img|br|hr|input|meta|link)[^>]*>/gi, "");

  // 4) Strip any remaining HTML tags but keep their inner text
  s = s.replace(/<\/?[^>]+>/g, "");

  // 5) Remove ATX headers (lines starting with #) and Setext underlines
  s = s.replace(/^\s{0,3}#{1,6}\s+.*$/gm, "");     // #, ##, ...
  s = s.replace(/^\s*[-=]{3,}\s*$/gm, "");         // --- or === underlines

  // 8) Remove markdown images ![alt](url)
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");

  // 9) Remove markdown tables (pipe rows)
  s = s.replace(/^\s*\|.*\|\s*$/gm, "");

  // 10) Decode a few common HTML entities
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([\da-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));

  // 11) Collapse extra whitespace
  s = s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return s.slice(0,1021) + "...";
}


async function sendToDiscord(payload: HFWebhookPayload, webhookUrl: string): Promise<void> {
  const { repo } = payload;

  const name = repo.name.toLowerCase();

  if (DENYLIST.some(keyword => name.includes(keyword))) {
    return; // exit early
  }

  // Determine color based on repo type
  const colors: Record<string, number> = {
    model: 0xFF9D00,      // Orange
    dataset: 0x00D1FF,    // Blue
    space: 0xFF006E,      // Pink
  };
  const color = colors[repo.type] || 0x808080; // Gray for unknown types

  // Determine emoji based on repo type

  // Format tags if present
  const tags = repo.tags?.slice(0, 5).join(', ') || 'None';

  const model_info_res = await fetch(repo.url.api);
  const model_info = await model_info_res.json();

  const readme_res = await fetch(`https://huggingface.co/${repo.name}/raw/main/README.md`)
  const readme = readme_res.status === 200 ? (await readme_res.text()) : null

  const discordPayload = {
    embeds: [
      {
        title: `${repo.name}`,
        description: cleanMarkdown(readme),
        color: color,
        fields: [
          {
            name: 'Type',
            value: repo.type.charAt(0).toUpperCase() + repo.type.slice(1),
            inline: true,
          },
        ],
        url: repo.url.web,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Hugging Face',
          icon_url: 'https://huggingface.co/front/assets/huggingface_logo-noborder.svg',
        },
      },
    ],
  };

  if ("safetensors" in model_info && "total" in model_info.safetensors) {
        discordPayload.embeds[0].fields.push({name: "Parameters", value: abbreviateNumber(model_info.safetensors.total), inline: true});
  }

  if ("cardData" in model_info && "license" in model_info.cardData) {
        discordPayload.embeds[0].fields.push({name: "License", value: model_info.cardData.license, inline: true});
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(discordPayload),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}`);
  }
}
